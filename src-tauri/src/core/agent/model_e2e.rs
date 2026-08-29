use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use super::llm_client::{LlamaBackend, LlamaServerClient, LlamaSessionTarget};
use super::model_profile::{detect_model_profile, AgentModelProfile};
use super::path_policy::EditableRoots;
use super::prompt::{
    build_stable_prefix_for_profile, CapabilitiesSummary, SkillDescriptor,
    DEFAULT_MAX_PARALLEL_TOOL_CALLS, ITERATION_ONE_TOOLS,
};
use super::runner::{
    run_turn_with_completion_deadline, RunTurnInput, PRODUCTION_TOOL_STEP_COMPLETION_DEADLINE,
};
use super::session::AgentSessionState;
use super::skills::{available_tool_names, SkillRegistry};
use super::test_support::{
    collect_event, RecordingApproval, RecordingDesktop, RecordingFolderAccess, TestWorkspace,
};
use super::types::{AgentEvent, ApprovalRequest, ToolCallPayload, ToolStatus};

const REQUIRED_MODEL_ID: &str = "Qwen3.5-9B-Q4_K_M";
const REQUIRED_MODEL_FILENAME: &str = "Qwen3.5-9B-Q4_K_M.gguf";
const REQUIRED_BACKEND_BUILD: &str = "10431";
const DOWNLOADS_SKILL: &str = "downloads-organizer";
const DOWNLOADS_AGENT_COMPLETION_DEADLINE: Duration = PRODUCTION_TOOL_STEP_COMPLETION_DEADLINE;

struct ManagedLlamaServer {
    child: Child,
    stdout_log: PathBuf,
    stderr_log: PathBuf,
}

impl ManagedLlamaServer {
    fn diagnostics(&mut self) -> String {
        let status = self.child.try_wait().ok().flatten();
        format!(
            "process_status={status:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
            read_log_tail(&self.stdout_log),
            read_log_tail(&self.stderr_log)
        )
    }
}

impl Drop for ManagedLlamaServer {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!(
                "Downloads Agent failure diagnostics:\n{}",
                self.diagnostics()
            );
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct LiveHarness {
    process: ManagedLlamaServer,
    workspace: TestWorkspace,
    downloads: PathBuf,
    client: LlamaServerClient,
    model_profile: AgentModelProfile,
    skill_registry: SkillRegistry,
    stable_prefix: String,
    session: AgentSessionState,
    timeout: Duration,
}

impl LiveHarness {
    async fn start() -> Self {
        let server_path = required_env_path("ATOMIC_AGENT_E2E_LLAMA_SERVER");
        let model_path = required_env_path("ATOMIC_AGENT_E2E_MODEL");
        assert_target_model(&model_path);
        assert_server_version(&server_path);

        let workspace = TestWorkspace::new();
        seed_bundled_downloads_skill(workspace.path());
        let skill_registry = SkillRegistry::load(
            workspace.path().join(".agent-skills"),
            &BTreeSet::from([DOWNLOADS_SKILL.to_owned()]),
            &available_tool_names(),
        )
        .expect("load bundled Downloads organizer");
        assert!(skill_registry.get_enabled(DOWNLOADS_SKILL).is_some());
        let downloads = workspace.path().join("Downloads");
        fs::create_dir(&downloads).expect("create isolated Downloads fixture");

        let port = reserve_loopback_port();
        let timeout = Duration::from_secs(env_u64("ATOMIC_AGENT_E2E_TIMEOUT_SECS", 900));
        let stdout_log = workspace.path().join("llama-server.stdout.log");
        let stderr_log = workspace.path().join("llama-server.stderr.log");
        print_provenance(&server_path, &model_path);
        let stdout = File::create(&stdout_log).expect("create llama-server stdout log");
        let stderr = File::create(&stderr_log).expect("create llama-server stderr log");
        let child = Command::new(&server_path)
            .current_dir(server_path.parent().expect("llama-server parent"))
            .args([
                "--model",
                model_path.to_str().expect("UTF-8 model path"),
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--parallel",
                "1",
                "--ctx-size",
                "8192",
                "--no-webui",
                "--jinja",
                "-ngl",
                "0",
            ])
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn()
            .unwrap_or_else(|error| panic!("failed to start {}: {error}", server_path.display()));
        let mut process = ManagedLlamaServer {
            child,
            stdout_log,
            stderr_log,
        };
        if let Err(error) = wait_for_health(port, timeout, &mut process).await {
            panic!("{error}\n{}", process.diagnostics());
        }

        let client = LlamaServerClient::new(&LlamaSessionTarget {
            port: i32::from(port),
            api_key: String::new(),
            model_id: REQUIRED_MODEL_ID.into(),
            has_vision: false,
            backend: LlamaBackend::LlamacppUpstream,
        })
        .expect("create upstream llama-server client");
        let profile_cancellation = CancellationToken::new();
        let model_profile = match client.fetch_props(&profile_cancellation).await {
            Ok(props) => detect_model_profile(&props),
            Err(error) => {
                eprintln!("Agent model-profile probe failed; using plain profile: {error}");
                AgentModelProfile::Plain
            }
        };
        let stable_prefix = downloads_stable_prefix(&skill_registry, &downloads, model_profile);
        Self {
            process,
            workspace,
            downloads,
            client,
            model_profile,
            skill_registry,
            stable_prefix,
            session: AgentSessionState::new("downloads-agent-acceptance"),
            timeout,
        }
    }

    async fn run_main(
        &mut self,
        run_id: &str,
        user_message: &str,
        selected_skill: Option<&str>,
        approval: &RecordingApproval,
        max_steps: u32,
    ) -> Vec<AgentEvent> {
        run_scenario(
            &mut self.process,
            &self.client,
            &self.skill_registry,
            &self.downloads,
            &self.stable_prefix,
            self.model_profile,
            &mut self.session,
            run_id,
            user_message,
            selected_skill,
            approval,
            max_steps,
            self.timeout,
        )
        .await
    }
}

#[test]
fn live_acceptance_uses_production_deadline_without_slowing_unit_tests() {
    assert_eq!(
        super::runner::TEST_TOOL_STEP_COMPLETION_DEADLINE,
        Duration::from_millis(100)
    );
    assert_eq!(
        DOWNLOADS_AGENT_COMPLETION_DEADLINE,
        Duration::from_secs(180)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires pinned upstream b10431 and Qwen3.5-9B Q4_K_M"]
async fn downloads_agent_acceptance() {
    let mut harness = LiveHarness::start().await;
    harness
        .workspace
        .write("Downloads/quarterly-report.pdf", "REPORT_SENTINEL_481");
    harness
        .workspace
        .write("Downloads/mystery.download", "UNCERTAIN_SENTINEL_927");
    let initial = BTreeMap::from([
        file("mystery.download", b"UNCERTAIN_SENTINEL_927"),
        file("quarterly-report.pdf", b"REPORT_SENTINEL_481"),
    ]);
    assert_snapshot(&harness.downloads, &initial);

    let plan_approval = RecordingApproval::deny();
    let plan = harness
        .run_main(
            "downloads-plan",
            "Call `os.fs.list` exactly once with `{\"path\":\".\"}` to inventory the connected Downloads folder. After observing that result, propose exactly one change: create `Documents` and move `quarterly-report.pdf` to `Documents/quarterly-report.pdf`. Leave `mystery.download` untouched because its type is uncertain. Do not mutate anything this turn. Use only relative paths, reply with the exact source and destination paths, and wait for acceptance.",
            Some(DOWNLOADS_SKILL),
            &plan_approval,
            5,
        )
        .await;
    assert_finished(&plan, "reply");
    assert_catalog_is_restricted(&plan);
    assert_no_mutating_tools(&plan);
    assert_eq!(count_tool(&plan, "os.fs.list"), 1, "events: {plan:#?}");
    assert_singleton_tool(&plan, "os.fs.list");
    assert_tool_string_arg(&plan, "os.fs.list", "path", ".");
    assert_tool_summary_mentions(
        &plan,
        "os.fs.list",
        &["quarterly-report.pdf", "mystery.download"],
    );
    assert!(plan_approval.requests().is_empty(), "events: {plan:#?}");
    assert_snapshot(&harness.downloads, &initial);
    assert_reply_mentions(
        &plan,
        &[
            "quarterly-report.pdf",
            "Documents/quarterly-report.pdf",
            "mystery.download",
        ],
    );

    let mutation_approval = RecordingApproval::allow();
    let apply = harness
        .run_main(
            "downloads-apply",
            "I explicitly accept that exact proposal. Use only these relative paths: `quarterly-report.pdf`, `Documents`, and `Documents/quarterly-report.pdf`. Create `Documents`, then move `quarterly-report.pdf` to `Documents/quarterly-report.pdf`. Do not move `mystery.download`. After both accepted actions succeed, list `.` and `Documents`, then reply with the exact moved and untouched paths.",
            None,
            &mutation_approval,
            8,
        )
        .await;
    assert_finished(&apply, "reply");
    assert_catalog_is_restricted(&apply);
    assert_eq!(count_tool(&apply, "os.fs.mkdir"), 1, "events: {apply:#?}");
    assert_eq!(count_tool(&apply, "os.fs.move"), 1, "events: {apply:#?}");
    assert_tool_string_arg(&apply, "os.fs.mkdir", "path", "Documents");
    assert_tool_string_arg(&apply, "os.fs.move", "source", "quarterly-report.pdf");
    assert_tool_string_arg(
        &apply,
        "os.fs.move",
        "destination",
        "Documents/quarterly-report.pdf",
    );
    assert_tool_status(&apply, "os.fs.mkdir", ToolStatus::Ok);
    assert_tool_status(&apply, "os.fs.move", ToolStatus::Ok);
    let canonical_downloads = fs::canonicalize(&harness.downloads).expect("canonical Downloads");
    let documents = canonical_downloads.join("Documents");
    assert_allow_once_requests(
        &mutation_approval.requests(),
        &[
            ExpectedApproval::mkdir(documents.clone()),
            ExpectedApproval::move_path(
                canonical_downloads.join("quarterly-report.pdf"),
                documents.join("quarterly-report.pdf"),
            ),
        ],
    );
    let applied = BTreeMap::from([
        directory("Documents"),
        file("Documents/quarterly-report.pdf", b"REPORT_SENTINEL_481"),
        file("mystery.download", b"UNCERTAIN_SENTINEL_927"),
    ]);
    assert_snapshot(&harness.downloads, &applied);
    assert_reply_mentions(
        &apply,
        &[
            "quarterly-report.pdf",
            "Documents/quarterly-report.pdf",
            "mystery.download",
        ],
    );

    let undo_approval = RecordingApproval::allow();
    let undo = harness
        .run_main(
            "downloads-undo",
            "Undo the one successful move from this same session using only relative paths: move `Documents/quarterly-report.pdf` back to `quarterly-report.pdf`. Do not remove `Documents` or touch `mystery.download`. After the approved reverse move succeeds, list `.` and `Documents`, then reply with the exact restored and untouched paths.",
            None,
            &undo_approval,
            6,
        )
        .await;
    assert_finished(&undo, "reply");
    assert_catalog_is_restricted(&undo);
    assert_eq!(count_tool(&undo, "os.fs.move"), 1, "events: {undo:#?}");
    assert_eq!(count_tool(&undo, "os.fs.mkdir"), 0, "events: {undo:#?}");
    assert_tool_string_arg(
        &undo,
        "os.fs.move",
        "source",
        "Documents/quarterly-report.pdf",
    );
    assert_tool_string_arg(&undo, "os.fs.move", "destination", "quarterly-report.pdf");
    assert_tool_status(&undo, "os.fs.move", ToolStatus::Ok);
    assert_allow_once_requests(
        &undo_approval.requests(),
        &[ExpectedApproval::move_path(
            documents.join("quarterly-report.pdf"),
            canonical_downloads.join("quarterly-report.pdf"),
        )],
    );
    let undone = BTreeMap::from([
        directory("Documents"),
        file("mystery.download", b"UNCERTAIN_SENTINEL_927"),
        file("quarterly-report.pdf", b"REPORT_SENTINEL_481"),
    ]);
    assert_snapshot(&harness.downloads, &undone);
    assert_reply_mentions(
        &undo,
        &[
            "Documents/quarterly-report.pdf",
            "quarterly-report.pdf",
            "mystery.download",
        ],
    );

    run_denied_scenario(&mut harness).await;
}

async fn run_denied_scenario(harness: &mut LiveHarness) {
    let denied_downloads = harness.workspace.path().join("DeniedDownloads");
    fs::create_dir(&denied_downloads).expect("create denied Downloads fixture");
    harness
        .workspace
        .write("DeniedDownloads/denied-report.pdf", "DENIED_SENTINEL_314");
    harness
        .workspace
        .write("DeniedDownloads/leave-alone.bin", "LEAVE_ALONE_159");
    let initial = BTreeMap::from([
        file("denied-report.pdf", b"DENIED_SENTINEL_314"),
        file("leave-alone.bin", b"LEAVE_ALONE_159"),
    ]);
    let stable_prefix = downloads_stable_prefix(
        &harness.skill_registry,
        &denied_downloads,
        harness.model_profile,
    );
    let mut session = AgentSessionState::new("downloads-agent-denied");
    let approval = RecordingApproval::deny();
    let events = run_scenario(
        &mut harness.process,
        &harness.client,
        &harness.skill_registry,
        &denied_downloads,
        &stable_prefix,
        harness.model_profile,
        &mut session,
        "downloads-denied",
        "This exact plan was already reviewed and I explicitly accept it: move `denied-report.pdf` to `Documents/denied-report.pdf`. Use only those relative paths and call `os.fs.move` exactly once now. The action will be denied; do not retry it or create anything, and reply that both `denied-report.pdf` and `leave-alone.bin` stayed where they were.",
        Some(DOWNLOADS_SKILL),
        &approval,
        4,
        harness.timeout,
    )
    .await;
    assert_finished(&events, "reply");
    assert_catalog_is_restricted(&events);
    assert_eq!(count_tool(&events, "os.fs.move"), 1, "events: {events:#?}");
    assert_eq!(count_tool(&events, "os.fs.mkdir"), 0, "events: {events:#?}");
    assert_tool_string_arg(&events, "os.fs.move", "source", "denied-report.pdf");
    assert_tool_string_arg(
        &events,
        "os.fs.move",
        "destination",
        "Documents/denied-report.pdf",
    );
    assert_tool_status(&events, "os.fs.move", ToolStatus::Denied);
    let requests = approval.requests();
    assert_eq!(requests.len(), 1, "events: {events:#?}");
    let canonical = fs::canonicalize(&denied_downloads).expect("canonical denied Downloads");
    assert_request_paths(
        &requests[0],
        &ExpectedApproval::move_path(
            canonical.join("denied-report.pdf"),
            canonical.join("Documents/denied-report.pdf"),
        ),
    );
    assert_snapshot(&denied_downloads, &initial);
    assert_reply_mentions(&events, &["denied-report.pdf", "leave-alone.bin"]);
}

#[allow(clippy::too_many_arguments)]
async fn run_scenario(
    process: &mut ManagedLlamaServer,
    client: &LlamaServerClient,
    skill_registry: &SkillRegistry,
    working_dir: &Path,
    stable_prefix: &str,
    model_profile: AgentModelProfile,
    session: &mut AgentSessionState,
    run_id: &str,
    user_message: &str,
    selected_skill: Option<&str>,
    approval: &RecordingApproval,
    max_steps: u32,
    timeout: Duration,
) -> Vec<AgentEvent> {
    let desktop = RecordingDesktop::default();
    let cancellation = CancellationToken::new();
    let editable_roots = EditableRoots::new(working_dir, &[]).await.unwrap();
    let folder_access = RecordingFolderAccess::deny();
    let session_id = session.session_id.clone();
    let mut events = Vec::new();
    let result = tokio::time::timeout(
        timeout,
        run_turn_with_completion_deadline(
            RunTurnInput {
                run_id,
                session_id: &session_id,
                user_message,
                selected_skill,
                stable_prefix,
                model_profile,
                working_dir,
                editable_roots: &editable_roots,
                external_read_only_roots: &[],
                trusted_read_roots: &[],
                max_steps,
                client,
                approval,
                folder_access: &folder_access,
                desktop: &desktop,
                cancellation: &cancellation,
                session,
                skill_registry,
                bundled_script_runtime: None,
                quota: None,
                restrict_to_yorebot_catalog: true,
            },
            DOWNLOADS_AGENT_COMPLETION_DEADLINE,
            |event| collect_event(&mut events, event),
        ),
    )
    .await;
    match result {
        Ok(Ok(())) => events,
        Ok(Err(error)) => panic!(
            "agent scenario {run_id} failed: {error}\nevents: {events:#?}\n{}",
            process.diagnostics()
        ),
        Err(_) => panic!(
            "agent scenario {run_id} exceeded {timeout:?}\nevents: {events:#?}\n{}",
            process.diagnostics()
        ),
    }
}

fn downloads_stable_prefix(
    skill_registry: &SkillRegistry,
    working_dir: &Path,
    model_profile: AgentModelProfile,
) -> String {
    let record = skill_registry
        .get_enabled(DOWNLOADS_SKILL)
        .expect("enabled bundled Downloads organizer");
    let skill = SkillDescriptor {
        name: record.manifest.name.clone(),
        description: record.manifest.description.clone(),
        version: record.manifest.version.clone(),
        requires_tools: record.manifest.requires_tools.clone(),
        requires_scripts: record.manifest.requires_scripts.clone(),
        dangerous: record.manifest.dangerous,
    };
    build_stable_prefix_for_profile(
        ITERATION_ONE_TOOLS,
        &[skill],
        &CapabilitiesSummary {
            platform: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            browser_channel: "none".into(),
            working_dir: working_dir.display().to_string(),
            has_clipboard: false,
            has_wmctrl: false,
            has_notifications: false,
        },
        DEFAULT_MAX_PARALLEL_TOOL_CALLS,
        None,
        model_profile,
    )
}

fn seed_bundled_downloads_skill(workspace: &Path) {
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources/agent-skills")
        .join(DOWNLOADS_SKILL)
        .join("SKILL.md");
    let destination = workspace
        .join(".agent-skills")
        .join(DOWNLOADS_SKILL)
        .join("SKILL.md");
    fs::create_dir_all(destination.parent().expect("skill destination parent"))
        .expect("create fixture skill directory");
    fs::copy(&source, &destination).unwrap_or_else(|error| {
        panic!(
            "copy bundled skill {} to {}: {error}",
            source.display(),
            destination.display()
        )
    });
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SnapshotEntry {
    Directory,
    File(Vec<u8>),
}

fn file(path: &str, content: &[u8]) -> (String, SnapshotEntry) {
    (path.to_owned(), SnapshotEntry::File(content.to_vec()))
}

fn directory(path: &str) -> (String, SnapshotEntry) {
    (path.to_owned(), SnapshotEntry::Directory)
}

fn assert_snapshot(root: &Path, expected: &BTreeMap<String, SnapshotEntry>) {
    let actual = snapshot(root);
    assert_eq!(
        &actual,
        expected,
        "unexpected disk state under {}",
        root.display()
    );
}

fn snapshot(root: &Path) -> BTreeMap<String, SnapshotEntry> {
    fn walk(root: &Path, directory: &Path, entries: &mut BTreeMap<String, SnapshotEntry>) {
        let mut children = fs::read_dir(directory)
            .unwrap_or_else(|error| panic!("read fixture {}: {error}", directory.display()))
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            let relative = path
                .strip_prefix(root)
                .expect("fixture child under root")
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let file_type = child.file_type().expect("fixture file type");
            if file_type.is_dir() {
                entries.insert(relative, SnapshotEntry::Directory);
                walk(root, &path, entries);
            } else if file_type.is_file() {
                entries.insert(
                    relative,
                    SnapshotEntry::File(fs::read(&path).expect("read fixture file")),
                );
            } else {
                panic!("unexpected fixture entry type: {}", path.display());
            }
        }
    }

    let mut entries = BTreeMap::new();
    walk(root, root, &mut entries);
    entries
}

struct ExpectedApproval {
    tool: &'static str,
    paths: Vec<(&'static str, PathBuf)>,
}

impl ExpectedApproval {
    fn mkdir(path: PathBuf) -> Self {
        Self {
            tool: "os.fs.mkdir",
            paths: vec![("path", path)],
        }
    }

    fn move_path(source: PathBuf, destination: PathBuf) -> Self {
        Self {
            tool: "os.fs.move",
            paths: vec![("source", source), ("destination", destination)],
        }
    }
}

fn assert_allow_once_requests(requests: &[ApprovalRequest], expected: &[ExpectedApproval]) {
    assert_eq!(
        requests.len(),
        expected.len(),
        "every mutation must receive exactly one AllowOnce request: {requests:#?}"
    );
    for (request, expected) in requests.iter().zip(expected) {
        assert_request_paths(request, expected);
        assert!(!request.can_remember, "approval must be one-action only");
    }
}

fn assert_request_paths(request: &ApprovalRequest, expected: &ExpectedApproval) {
    assert_eq!(request.tool, expected.tool, "approval order changed");
    for (field, path) in &expected.paths {
        let actual = request
            .preview
            .get(*field)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_else(|| panic!("approval preview lacks exact {field}: {request:#?}"));
        assert_eq!(
            Path::new(actual),
            path.as_path(),
            "approval preview changed {field}"
        );
    }
}

fn assert_catalog_is_restricted(events: &[AgentEvent]) {
    let allowed = ITERATION_ONE_TOOLS
        .iter()
        .map(|descriptor| descriptor.name)
        .collect::<BTreeSet<_>>();
    for call in parsed_calls(events) {
        assert!(
            allowed.contains(call.tool.as_str()),
            "non-YoreBot tool escaped restricted catalog: {call:#?}"
        );
    }
}

fn assert_no_mutating_tools(events: &[AgentEvent]) {
    for tool in ["os.fs.mkdir", "os.fs.move"] {
        assert_eq!(
            count_tool(events, tool),
            0,
            "unexpected {tool}: {events:#?}"
        );
    }
}

fn parsed_calls(events: &[AgentEvent]) -> Vec<&ToolCallPayload> {
    events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ToolCallParsed { call, .. } => Some(call),
            _ => None,
        })
        .collect()
}

fn count_tool(events: &[AgentEvent], tool: &str) -> usize {
    parsed_calls(events)
        .into_iter()
        .filter(|call| call.tool == tool)
        .count()
}

fn assert_tool_string_arg(events: &[AgentEvent], tool: &str, field: &str, expected: &str) {
    let calls = parsed_calls(events)
        .into_iter()
        .filter(|call| call.tool == tool)
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 1, "expected one {tool} call: {events:#?}");
    assert_eq!(
        calls[0].args.get(field).and_then(serde_json::Value::as_str),
        Some(expected),
        "{tool}.{field} must use the exact relative path: {events:#?}"
    );
}

fn assert_singleton_tool(events: &[AgentEvent], tool: &str) {
    assert!(
        events.iter().any(|event| matches!(
            event,
            AgentEvent::ToolCallParsed {
                call,
                batch_size: 1,
                ..
            } if call.tool == tool
        )),
        "{tool} must run alone so its result is observed before the proposal: {events:#?}"
    );
}

fn assert_tool_summary_mentions(events: &[AgentEvent], tool: &str, values: &[&str]) {
    let summary = events
        .iter()
        .find_map(|event| match event {
            AgentEvent::ToolCallExecuted { result } if result.call.tool == tool => {
                Some(result.outcome.summary.as_str())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing {tool} outcome: {events:#?}"));
    for value in values {
        assert!(
            summary.contains(value),
            "{tool} did not observe {value}: {summary}"
        );
    }
}

fn assert_reply_mentions(events: &[AgentEvent], expected_paths: &[&str]) {
    let reply = events
        .iter()
        .rev()
        .find_map(|event| match event {
            AgentEvent::AssistantReply { text } => Some(text.replace('\\', "/")),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing assistant reply: {events:#?}"));
    for path in expected_paths {
        assert!(reply.contains(path), "reply omits {path:?}: {reply:?}");
    }
}

fn assert_tool_status(events: &[AgentEvent], tool: &str, status: ToolStatus) {
    assert!(
        events.iter().any(|event| matches!(
            event,
            AgentEvent::ToolCallExecuted { result }
                if result.call.tool == tool && result.outcome.status == status
        )),
        "expected {tool} status {status:?}; events: {events:#?}"
    );
}

fn assert_finished(events: &[AgentEvent], expected_reason: &str) {
    assert!(
        events.iter().any(|event| matches!(
            event,
            AgentEvent::TurnFinished { reason, .. } if reason == expected_reason
        )),
        "expected TurnFinished({expected_reason:?}), got {events:#?}"
    );
}

fn required_env_path(name: &str) -> PathBuf {
    let value = std::env::var(name)
        .unwrap_or_else(|_| panic!("{name} is required for downloads_agent_acceptance"));
    let path = PathBuf::from(value);
    assert!(path.is_file(), "{name} is not a file: {}", path.display());
    path
}

fn assert_target_model(path: &Path) {
    assert_eq!(
        path.file_name().and_then(|name| name.to_str()),
        Some(REQUIRED_MODEL_FILENAME),
        "ATOMIC_AGENT_E2E_MODEL must be exact pinned {REQUIRED_MODEL_FILENAME}; got {}",
        path.display()
    );
}

fn assert_server_version(server_path: &Path) {
    let output = version_output(server_path).unwrap_or_else(|error| {
        panic!(
            "failed to inspect pinned llama-server {}: {error}",
            server_path.display()
        )
    });
    assert!(
        output.contains(&format!("(build {REQUIRED_BACKEND_BUILD},"))
            || output.contains(&format!("version: b{REQUIRED_BACKEND_BUILD}")),
        "llama-server must report upstream build {REQUIRED_BACKEND_BUILD}; got {output:?}"
    );
}

fn version_output(server_path: &Path) -> Result<String, String> {
    let output = Command::new(server_path)
        .current_dir(server_path.parent().ok_or("llama-server has no parent")?)
        .arg("--version")
        .output()
        .map_err(|error| error.to_string())?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        return Err(format!("{}: {}", output.status, text.trim()));
    }
    Ok(text)
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn reserve_loopback_port() -> u16 {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .expect("reserve loopback port");
    listener.local_addr().expect("reserved address").port()
}

fn print_provenance(server_path: &Path, model_path: &Path) {
    let version = version_output(server_path)
        .unwrap_or_else(|error| format!("<version probe failed: {error}>"));
    let version_file = server_path
        .ancestors()
        .skip(1)
        .map(|parent| parent.join("version.txt"))
        .find(|candidate| candidate.is_file());
    let version_file_text = version_file
        .as_ref()
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_else(|| "<not found>".into());
    eprintln!(
        "Downloads Agent acceptance provenance:\nmodel_id={REQUIRED_MODEL_ID}\nmodel_path={}\nllama_server={}\nllama_server_version={}\nversion_file={:?}\nversion_file_contents={}",
        model_path.display(),
        server_path.display(),
        version.trim(),
        version_file,
        version_file_text.trim()
    );
}

async fn wait_for_health(
    port: u16,
    timeout: Duration,
    process: &mut ManagedLlamaServer,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| error.to_string())?;
    let health_url = format!("http://127.0.0.1:{port}/health");
    let started = Instant::now();
    loop {
        if let Some(status) = process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
        {
            return Err(format!("llama-server exited before readiness: {status}"));
        }
        if let Ok(response) = client.get(&health_url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "llama-server health check timed out after {timeout:?}"
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn read_log_tail(path: &Path) -> String {
    const MAX_LOG_CHARS: usize = 20_000;
    let Ok(content) = fs::read_to_string(path) else {
        return "<unavailable>".into();
    };
    let chars = content.chars().collect::<Vec<_>>();
    chars[chars.len().saturating_sub(MAX_LOG_CHARS)..]
        .iter()
        .collect()
}
