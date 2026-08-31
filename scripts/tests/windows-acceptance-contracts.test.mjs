import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const multilinePwshBlocks = (source) => {
  const lines = source.split('\n')
  const blocks = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      lines[index].trim() !== 'shell: pwsh' ||
      lines[index + 1].trim() !== 'run: |'
    ) {
      continue
    }
    const name = lines
      .slice(Math.max(0, index - 3), index)
      .reverse()
      .map((line) => line.match(/^\s*- name:\s*(.+)$/)?.[1])
      .find(Boolean) ?? 'unnamed pwsh step'
    const body = []
    for (let lineIndex = index + 2; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]
      const indentation = line.match(/^ */)[0].length
      if (line.trim() && indentation <= 8) break
      body.push(line.startsWith('          ') ? line.slice(10) : line)
    }
    blocks.push({ name, statements: body.filter((line) => line.trim()) })
  }
  return blocks.filter(({ statements }) => statements.length > 1)
}

test('ordinary and high-end Windows models and CPU runtime remain exactly pinned', () => {
  const models = read('web-app/src/constants/yorebot-models.ts')
  const backends = read('extensions/llamacpp-upstream-extension/src/backend.ts')

  for (const value of [
    "id: 'Qwen3.5-9B-Q4_K_M'",
    "repository: 'unsloth/Qwen3.5-9B-GGUF'",
    "revision: '3885219b6810b007914f3a7950a8d1b469d598a5'",
    "filename: 'Qwen3.5-9B-Q4_K_M.gguf'",
    'sizeBytes: 5_680_522_464',
    "sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'",
  ]) {
    assert.ok(models.includes(value), `missing model pin: ${value}`)
  }

  for (const value of [
    "id: 'Qwen3.8-27B-Q4_K_M'",
    "repository: 'ggml-org/Qwen3.8-27B-GGUF'",
    "revision: '0669b98607d47046c7c2b3f801011d54a08cfccf'",
    "filename: 'Qwen3.8-27B-Q4_K_M.gguf'",
    'sizeBytes: 18_973_870_432',
    "sha256: '31629f53165ab6a7dad8c9847dcfd1fdf55829dac1e6e748f4a68581b0033d34'",
  ]) {
    assert.ok(models.includes(value), `missing high-end model pin: ${value}`)
  }

  for (const value of [
    "version: 'b10431'",
    "backend: 'win-cpu-x64'",
    "filename: 'llama-b10431-bin-win-cpu-x64.zip'",
    'size: 18_462_983',
    "sha256: 'aa16a2102de8730be6079f67f77997ca549e9a07125563571afb2fb4e810ec2c'",
  ]) {
    assert.ok(backends.includes(value), `missing backend pin: ${value}`)
  }
})

test('Agent executable resolution handles Cargo JSON shapes and fails closed', () => {
  const script = read('scripts/test-windows-pinned-model.ps1')
  const workflow = read('.github/workflows/windows-internal.yml')

  assert.match(workflow, /test-windows-pinned-model\.ps1 -ValidateCargoParserOnly/)
  assert.match(script, /\[switch\] \$ValidateCargoParserOnly/)
  assert.match(script, /\[switch\] \$ValidateCargoResolverOnly/)
  assert.match(script, /ConvertFrom-Json -AsHashtable -Depth 40/)
  assert.doesNotMatch(
    script.slice(
      script.indexOf('function Resolve-AgentAcceptanceExecutableFromCargoLines'),
      script.indexOf('\nfunction Resolve-AgentAcceptanceExecutable {')
    ),
    /\.PSObject\.Properties/
  )
  for (const fixture of [
    'single Cargo compiler-artifact',
    'mixed Cargo compiler-artifacts',
    'zero matching Cargo compiler-artifacts',
    'multiple matching Cargo compiler-artifacts',
  ]) {
    assert.ok(script.includes(fixture), `missing Cargo parser fixture: ${fixture}`)
  }
  for (const field of [
    'target_name=',
    'target_kind=',
    'target_crate_types=',
    'target_test=',
    'profile_test=',
    'executable_basename=',
    'executable_present=',
    'executable_exists=',
  ]) {
    assert.ok(script.includes(field), `Cargo diagnostic omits ${field}`)
  }
  assert.match(script, /Cargo compiler-artifact diagnostics: count=/)
  assert.match(script, /\$executablePresent -or \$targetName -ceq 'app_lib'/)
  assert.match(script, /Select-Object -Last 40/)
  assert.match(script, /\[string\]\$target\['name'\] -cne 'app_lib'/)
  assert.match(script, /\$target\['test'\] -isnot \[bool\]/)
  assert.match(script, /\$target\['test'\] -ne \$true/)
  assert.match(script, /-not \$executableExists/)
  assert.match(script, /name = 'dependency_lib'/)
  assert.match(script, /kind = @\('staticlib', 'cdylib', 'rlib'\)/)

  const productSeams = workflow.indexOf('- name: Test product seams')
  const resolver = workflow.indexOf('- name: Verify real Agent acceptance resolver')
  const installer = workflow.indexOf('- name: Build unsigned internal NSIS installer')
  assert.ok(productSeams >= 0 && resolver > productSeams && installer > resolver)
  assert.match(
    workflow.slice(resolver, installer),
    /test-windows-pinned-model\.ps1 -ValidateCargoResolverOnly/
  )
})

test('manual Windows proof selects the largest exact fit and fails before downloads', () => {
  const script = read('scripts/test-windows-pinned-model.ps1')
  const workflow = read('.github/workflows/windows-internal.yml')

  for (const value of [
    "'ordinary-16gb' { 16 * 1024 }",
    "'high-end-32gb' { 32 * 1024 }",
    "'unsupported-4gb' { 4 * 1024 }",
    "'unknown' { 0 }",
    'No pinned model fits hardware profile',
    'Hardware profile memory is unknown',
    'Qwen3.5-9B-Q4_K_M',
    'Qwen3.8-27B-Q4_K_M',
  ]) {
    assert.ok(script.includes(value), `missing profile guard: ${value}`)
  }

  const profile = script.indexOf('$profileMemoryMb = switch ($HardwareProfile)')
  const selection = script.indexOf('$model = @(')
  const workRoot = script.indexOf('$workRootFull =')
  const actualMemory = script.indexOf('$actualMemoryBytes = Get-ActualPhysicalMemoryBytes')
  const freeDisk = script.indexOf('$availableDiskBytes = Get-AvailableDiskBytes')
  const createRoot = script.indexOf('New-Item -ItemType Directory -Path $workRootFull')
  const download = script.indexOf('Invoke-PinnedDownload -Url $backendUrl')
  assert.ok(profile >= 0 && selection > profile)
  assert.ok(workRoot > selection && actualMemory > workRoot)
  assert.ok(freeDisk > actualMemory && createRoot > freeDisk && download > createRoot)
  assert.match(script, /selected pinned model does not fit actual Windows RAM/)
  assert.match(script, /\$model\.Size \* 10 -gt \$actualMemoryBytes \* 7/)
  assert.doesNotMatch(script, /\$actualMemoryBytes -lt \$profileMemoryBytes/)
  assert.match(script, /does not have enough free disk before model download/)
  assert.match(script, /\$requiredDiskBytes = \[int64\]\$model\.Size \+/)
  assert.match(script, /\$profileMemoryBytes = \[int64\]\$profileMemoryMb \* 1MB/)
  for (const field of [
    'model_revision=',
    'model_size_bytes=',
    'model_sha256=',
    'runtime_version=',
    'runtime_variant=',
    'runtime_size_bytes=',
    'runtime_sha256=',
  ]) {
    assert.ok(script.includes(field), `acceptance evidence omits ${field}`)
  }

  assert.match(workflow, /hardware_profile:/)
  assert.match(workflow, /High-end requires a future Windows runner with 32GB\+ RAM/)
  assert.match(workflow, /default: ordinary-16gb/)
  assert.match(workflow, /- ordinary-16gb/)
  assert.match(workflow, /- high-end-32gb/)
  assert.match(workflow, /-HardwareProfile \$profile/)
  assert.doesNotMatch(workflow, /RunDownloadsAgentAcceptance[\s\S]*pull_request/)
})

test('Windows extension bundle is a fail-closed allowlist without TurboQuant', () => {
  const packageJson = JSON.parse(read('package.json'))
  const verifier = read('scripts/verify-windows-extension-bundle.mjs')
  const internal = read('.github/workflows/windows-internal.yml')
  const signed = read('.github/workflows/windows-signed-candidate.yml')
  const setup = read('src-tauri/src/core/setup.rs')
  const extensionCommands = read('src-tauri/src/core/extensions/commands.rs')

  const build = packageJson.scripts['build:extensions:win32']
  for (const workspace of [
    '@janhq/assistant-extension',
    '@janhq/conversational-extension',
    '@janhq/download-extension',
    '@janhq/llamacpp-upstream-extension',
    '@janhq/rag-extension',
    '@janhq/vector-db-extension',
  ]) {
    assert.ok(build.includes(`--include ${workspace}`), `missing allowlist entry: ${workspace}`)
    assert.ok(verifier.includes(`'${workspace}'`), `missing inventory entry: ${workspace}`)
  }

  assert.doesNotMatch(build, /--exclude/)
  assert.doesNotMatch(build, /@janhq\/llamacpp-extension/)
  assert.match(build, /rimraf --glob ['"]\.\/pre-install\/\*\.tgz['"] &&/)
  assert.doesNotMatch(build, /\|\| true/)
  assert.match(internal, /yarn verify:extensions:win32/)
  assert.match(signed, /yarn verify:extensions:win32/)
  assert.match(verifier, /Unexpected Windows extension bundle inventory/)

  const installer = setup.slice(setup.indexOf('pub fn install_extensions'))
  assert.ok(
    installer.indexOf('prepare_yorebot_windows_extension_inventory') <
      installer.indexOf('if !clean_up && extensions_path.exists()'),
    'same-version allowlist migration must run before the early return'
  )
  assert.match(
    extensionCommands,
    /filter_yorebot_windows_extension_manifest\(&extensions_path, exts\)/
  )
  assert.match(internal, /core::setup::tests::/)
})

test('Windows runs the generated-content and startup zero-egress regressions', () => {
  const internal = read('.github/workflows/windows-internal.yml')
  const config = JSON.parse(read('src-tauri/tauri.conf.json'))
  const app = read('src-tauri/src/lib.rs')
  const html = read('web-app/src/containers/HtmlArtifact.tsx')
  const markdown = read('web-app/src/containers/RenderMarkdown.tsx')
  const autoEgress = read(
    'web-app/src/services/__tests__/yorebot-auto-egress.test.ts'
  )

  for (const suite of [
    'RenderMarkdown.security.test.tsx',
    'HtmlArtifact.security.test.tsx',
    'yorebot-auto-egress.test.ts',
  ]) {
    assert.ok(internal.includes(suite), `Windows CI omits ${suite}`)
  }
  assert.equal(
    config.app.security.csp['img-src'],
    "'self' asset: http://asset.localhost blob: data:"
  )
  assert.doesNotMatch(app, /register_uri_scheme_protocol\("artifact"/)
  assert.doesNotMatch(html, /<iframe|set_artifact_html|allow-popups|allow-forms/)
  assert.doesNotMatch(markdown, /@streamdown\/mermaid/)
  assert.match(markdown, /data-blocked-markdown-image/)
  assert.match(
    autoEgress,
    /imports the production route tree[\s\S]*?\}, 20_000\)/
  )
})

test('disabled public updater is not registered during desktop startup', () => {
  const app = read('src-tauri/src/lib.rs')
  const config = JSON.parse(read('src-tauri/tauri.conf.json'))

  assert.doesNotMatch(app, /plugin\(tauri_plugin_updater::/)
  assert.equal(config.bundle.createUpdaterArtifacts, false)
  assert.equal(Object.hasOwn(config.plugins, 'updater'), false)
})

test('installer smoke owns exact processes and protects prefix siblings', () => {
  const script = read('scripts/test-windows-installer.ps1')
  const hooks = read('src-tauri/windows/hooks.nsh')
  const cleanup = read('src-tauri/resources/stop-yorebot-owned-processes.ps1')
  const cleanupTest = read('scripts/test-windows-uninstall-cleanup.ps1')
  const workflow = read('.github/workflows/windows-internal.yml')
  const windowsConfig = JSON.parse(read('src-tauri/tauri.windows.conf.json'))

  for (const value of [
    "'YoreBotTools'",
    "-Name 'llama-server'",
    "-Name 'bun'",
    "-Name 'uv'",
    'Get-ProcessesAtExactPath',
    'Stop-Process -Id',
    '-WorkingDirectory $installRoot',
    '-RedirectStandardOutput $appStdoutPath',
    '-RedirectStandardError $appStderrPath',
    'Write-LaunchDiagnostics',
    'YoreBot exited during startup with exit code',
    'Bundled llama.cpp backend ready during startup: b10431/win-cpu-x64',
    'did not report its exact bundled backend ready',
    "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\YoreBot'",
    'use a fresh Windows runner',
    'Uninstaller touched sibling sentinel',
  ]) {
    assert.ok(script.includes(value), `missing installer guard: ${value}`)
  }
  assert.doesNotMatch(script, /Stop-Process\s+-Name/i)
  assert.doesNotMatch(script, /taskkill/i)
  assert.doesNotMatch(script, /if\s*\(\$launchedApp\.ExitCode/i)
  assert.doesNotMatch(script, /exited cleanly/i)
  const backendReadyPoll = script.slice(
    script.indexOf("$backendReady = 'Bundled llama.cpp backend ready during startup: b10431/win-cpu-x64'"),
    script.indexOf('New-Item -ItemType Directory -Path $installSibling, $dataSibling')
  )
  assert.match(backendReadyPoll, /\$backendReadyDeadline = \(Get-Date\)\.AddSeconds\(60\)/)
  assert.match(backendReadyPoll, /\$launchedApp\.Refresh\(\)/)
  assert.match(backendReadyPoll, /if \(\$launchedApp\.HasExited\)/)
  assert.match(backendReadyPoll, /Start-Sleep -Milliseconds 500/)
  assert.match(backendReadyPoll, /while \(\(Get-Date\) -lt \$backendReadyDeadline\)/)
  assert.ok(
    script.indexOf('Stop-ExactProcesses -Path $appPath') <
      script.indexOf('$launchedApp = Start-Process')
  )
  assert.ok(
    script.indexOf('New-Item -ItemType Directory -Path $installSibling, $dataSibling') <
      script.indexOf("Join-Path $installSibling 'keep.txt'")
  )
  assert.doesNotMatch(hooks, /\$INSTDIR\*/)
  assert.doesNotMatch(hooks, /\$APPDATA\\YoreBot\*/)
  assert.match(cleanup, /\.StartsWith\(/)
  assert.match(cleanup, /\[char\]92/)
  assert.match(hooks, /stop-yorebot-owned-processes\.ps1/)
  assert.match(hooks, /nsExec::ExecToStack/)
  assert.match(hooks, /SetErrorLevel 1[\s\S]*Quit/)
  assert.ok(
    windowsConfig.bundle.resources.includes(
      'resources/stop-yorebot-owned-processes.ps1',
    ),
    'cleanup helper must be bundled through the Tauri resource manifest',
  )
  assert.match(hooks, /-File "\$INSTDIR\\resources\\stop-yorebot-owned-processes\.ps1"/)
  assert.match(hooks, /-MainExecutable "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"/)
  assert.doesNotMatch(hooks, /-File "\$INSTDIR\\stop-yorebot-owned-processes\.ps1"/)
  assert.match(hooks, /!macro NSIS_HOOK_POSTINSTALL[\s\S]*!insertmacro YOREBOT_STOP_OWNED_PROCESSES/)
  assert.match(hooks, /!macro NSIS_HOOK_PREUNINSTALL[\s\S]*!insertmacro YOREBOT_STOP_OWNED_PROCESSES/)
  assert.doesNotMatch(hooks, /\bFile\s+\/oname=/)
  assert.doesNotMatch(hooks, /\$PLUGINSDIR\\YoreBotStopOwnedProcesses/)
  const preuninstall = hooks.slice(
    hooks.indexOf('!macro NSIS_HOOK_PREUNINSTALL'),
    hooks.indexOf('!macroend', hooks.indexOf('!macro NSIS_HOOK_PREUNINSTALL')),
  )
  assert.doesNotMatch(preuninstall, /SetOutPath "\$INSTDIR"/)
  assert.match(cleanup, /QueryFullProcessImageNameW/)
  assert.match(cleanup, /ProcessQueryLimitedInformation = 0x1000/)
  assert.match(cleanup, /Get-Process -Name \$mainProcessName/)
  assert.match(cleanup, /Get-Process -Name llama-server,bun,uv/)
  assert.match(cleanup, /Stop-Process -Id/)
  assert.match(cleanup, /\[DateTime\]::UtcNow\.AddSeconds\(15\)/)
  assert.match(cleanup, /\.StartsWith\([\s\S]*\[System\.StringComparison\]::OrdinalIgnoreCase/)
  assert.doesNotMatch(cleanup, /Stop-Process\s+-Name/i)
  assert.doesNotMatch(cleanup, /taskkill/i)
  for (const value of [
    "'YoreBotTools'",
    "'Roaming/YoreBotBackup'",
    "'OtherApp'",
    "-Name 'Atomic-Chat'",
    "-Name 'llama-server'",
    "-Name 'bun'",
    "-Name 'uv'",
    "'SysWOW64/WindowsPowerShell/v1.0/powershell.exe'",
    '-File $cleanupScript',
    '-MainExecutable $mainExecutable',
    'engine_bits=32 main_stopped=$ExpectedMain helpers_stopped=$ExpectedHelpers remaining=0',
    'Invoke-Cleanup',
    'Owned helper survived uninstall cleanup',
    'Older-version orphan survived reinstall cleanup',
    'Cleanup terminated a sibling or unrelated helper',
  ]) {
    assert.ok(cleanupTest.includes(value), `missing cleanup regression: ${value}`)
  }
  assert.ok(
    cleanup.indexOf('$mainVictims =') < cleanup.indexOf('$helperVictims ='),
    'the exact main app must be stopped before its owned helpers',
  )
  assert.match(workflow, /\.\/scripts\/test-windows-uninstall-cleanup\.ps1/)
  assert.match(script, /resources\/stop-yorebot-owned-processes\.ps1/)
})

test('model smoke verifies both downloads before an exact outbound block and loopback request', () => {
  const script = read('scripts/test-windows-pinned-model.ps1')
  const backendDownload = script.indexOf('Invoke-PinnedDownload -Url $backendUrl')
  const modelDownload = script.indexOf('Invoke-PinnedDownload -Url $modelUrl')
  const firewall = script.indexOf('New-NetFirewallRule')
  const serverStart = script.indexOf('Start-Process -FilePath $serverPath')
  const prompt = script.indexOf('/v1/chat/completions')

  assert.ok(backendDownload >= 0 && modelDownload > backendDownload)
  assert.ok(firewall > modelDownload)
  assert.ok(serverStart > firewall)
  assert.ok(prompt > serverStart)
  assert.match(script, /-Program \$serverPath/)
  assert.match(script, /--host', '127\.0\.0\.1'/)
  assert.match(script, /Pinned model returned an empty response/)
  assert.match(script, /\$backendUrl = "https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download/)
  assert.match(script, /sha256:\\s\*'\[0-9a-f\]\{64\}'/)
  assert.doesNotMatch(script, /Get-StringField \$backendBlock 'url'/)
  assert.match(script, /\.PSObject\.Properties\['content'\]/)
  assert.match(script, /\.PSObject\.Properties\['reasoning_content'\]/)
  assert.doesNotMatch(script, /tokens?\s*(\/|per)\s*second|throughput|benchmark/i)
  assert.doesNotMatch(script, /Stop-Process\s+-Name/i)
})

test('real Chat and Agent work run inside one restored process-attributed network audit', () => {
  assert.ok(
    existsSync(resolve(root, 'scripts/windows-network-audit.ps1')),
    'the shared Windows network-audit helper is missing'
  )
  const audit = read('scripts/windows-network-audit.ps1')
  const auditRegression = read('scripts/test-windows-network-audit.ps1')
  const firstUse = read('scripts/test-windows-first-use.ps1')
  const agent = read('scripts/test-windows-pinned-model.ps1')
  const workflow = read('.github/workflows/windows-internal.yml')

  for (const value of [
    '{0CCE9226-69AE-11D9-BED3-505054503030}',
    'auditpol.exe /backup',
    'auditpol.exe /set',
    'auditpol.exe /restore',
    'Get-WinEvent',
    '5157',
    'QueryDosDeviceW',
    'ProcessId',
    'Application',
    'DestAddress',
    '%%14593',
    'New-NetFirewallRule',
    '-Program $canonicalPath',
    '0.0.0.0-126.255.255.255',
    '128.0.0.0-255.255.255.255',
    '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'Remove-NetFirewallRule',
    'Non-loopback network attempt detected',
    '/failure:enable',
    'Network-audited program has no observed exact-path process',
  ]) {
    assert.ok(audit.includes(value), `missing network-audit guard: ${value}`)
  }
  assert.match(audit, /Select-Object -First 20/)
  assert.doesNotMatch(audit, /\/success:enable/)
  assert.doesNotMatch(audit, /RemoteAddress\s+Any|Stop-Process\s+-Name/i)
  assert.match(
    audit,
    /Remove-NetFirewallRule[\s\S]*?-PolicyStore ActiveStore[\s\S]*?-ErrorAction SilentlyContinue/
  )
  assert.match(
    audit,
    /Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop[\s\S]*?\.DisplayName\.StartsWith\([\s\S]*?\$State\.RulePrefix/
  )

  for (const value of [
    'Start-YoreBotNetworkAudit',
    'Add-YoreBotNetworkAuditProgram',
    'Watch-YoreBotNetworkProcess',
    'Assert-YoreBotNetworkAudit',
    'Stop-YoreBotNetworkAudit',
    '192.0.2.1',
    'caught expected non-loopback attempt',
    'audit policy was not restored',
    "'127.255.255.255'",
    "'::2'",
  ]) {
    assert.ok(
      auditRegression.includes(value),
      `missing live audit regression: ${value}`
    )
  }
  assert.match(
    auditRegression,
    /Get-NetFirewallRule\s+`\s*-DisplayName \$program\.RuleName\s+`\s*-PolicyStore ActiveStore/
  )
  assert.match(
    auditRegression,
    /Remove-NetFirewallRule\s+`\s*-DisplayName \$program\.RuleName\s+`\s*-PolicyStore ActiveStore/
  )
  assert.equal(
    (auditRegression.match(/Stop-YoreBotNetworkAudit -State \$audit/g) ?? [])
      .length,
    2,
    'cleanup retry must be regression-tested'
  )

  const firstUseDownload = firstUse.indexOf(
    "Get-FileHash -LiteralPath $modelPath -Algorithm SHA256"
  )
  const firstUseAudit = firstUse.indexOf('Start-YoreBotNetworkAudit')
  const firstUsePrompt = firstUse.indexOf(
    'Reply with exactly YOREBOT_CHAT_OK.'
  )
  const firstUseAssert = firstUse.indexOf('Assert-YoreBotNetworkAudit')
  assert.ok(
    firstUseDownload >= 0 &&
      firstUseAudit > firstUseDownload &&
      firstUsePrompt > firstUseAudit &&
      firstUseAssert > firstUsePrompt
  )
  assert.match(firstUse, /Add-YoreBotNetworkAuditProgram[\s\S]*-Path \$appPath/)
  assert.match(firstUse, /Add-YoreBotNetworkAuditProgram[\s\S]*-Path \$serverPath/)
  assert.match(firstUse, /Watch-YoreBotNetworkProcess[\s\S]*-Process \$appProcess/)
  assert.match(firstUse, /Watch-YoreBotNetworkProcess[\s\S]*-Process \$serverProcess/)
  for (const value of [
    "'Network.enable'",
    "'Network.requestWillBeSent'",
    "'Network.webSocketCreated'",
    'Assert-CdpNetworkAudit',
    '$uri.IsUnc',
    'Get-CdpNetworkUriDiagnostic',
    'WebView2 Network sensor did not observe the expected loopback health request',
    "$uri.AbsolutePath -cne '/health'",
    'WebView2 loopback health calibration failed',
  ]) {
    assert.ok(firstUse.includes(value), `missing WebView2 network guard: ${value}`)
  }
  assert.match(
    firstUse,
    /if \(\$uri\.Host -ieq 'ipc\.localhost'\) \{[\s\S]*?\$uri\.Scheme -eq 'http'[\s\S]*?\$uri\.Port -eq 80[\s\S]*?\}/,
    'the Tauri IPC origin must remain exact http://ipc.localhost:80'
  )
  assert.match(
    firstUse,
    /\$uri\.Host -iin @\('localhost', 'tauri\.localhost', 'asset\.localhost'\)/
  )
  assert.match(
    firstUse,
    /'Network\.enable'[\s\S]*fetch\('http:\/\/127\.0\.0\.1:\$healthPort\/health'[\s\S]*response\.ok[\s\S]*WebView2 loopback health calibration failed[\s\S]*\$baselineReplyValue/
  )
  const calibration = firstUse.slice(
    firstUse.indexOf("'Network.enable'"),
    firstUse.indexOf('$baselineReplyValue')
  )
  assert.equal((calibration.match(/\bfetch\(/g) ?? []).length, 1)
  assert.doesNotMatch(firstUse, /SkipExistingConnectionCheck/)
  assert.match(firstUse, /finally \{[\s\S]*Stop-YoreBotNetworkAudit/)

  const agentDownload = agent.indexOf(
    'Assert-PinnedFile -Path $modelPath -Size $model.Size'
  )
  const agentAudit = agent.indexOf('Start-YoreBotNetworkAudit')
  const agentRun = agent.indexOf(
    'core::agent::model_e2e::downloads_agent_acceptance'
  )
  const agentAssert = agent.indexOf('Assert-YoreBotNetworkAudit')
  assert.ok(
    agentDownload >= 0 &&
      agentAudit > agentDownload &&
      agentRun > agentAudit &&
      agentAssert > agentRun
  )
  assert.match(agent, /Add-YoreBotNetworkAuditProgram[\s\S]*-Path \$serverPath/)
  assert.match(agent, /Add-YoreBotNetworkAuditProgram[\s\S]*-Path \$agentTestExecutable/)
  assert.match(agent, /Watch-YoreBotNetworkProcess[\s\S]*-Process \$agentTestProcess/)
  assert.match(agent, /finally \{[\s\S]*Stop-YoreBotNetworkAudit/)

  assert.match(workflow, /\.\/scripts\/test-windows-network-audit\.ps1/)
  assert.match(workflow, /\.\/scripts\/test-windows-first-use\.ps1/)
  assert.match(workflow, /-RunDownloadsAgentAcceptance/)
})

test('manual model ritual exercises the real Downloads Agent contract', () => {
  const script = read('scripts/test-windows-pinned-model.ps1')
  const harness = read('src-tauri/src/core/agent/model_e2e.rs')
  const runner = read('src-tauri/src/core/agent/runner.rs')
  const workflow = read('.github/workflows/windows-internal.yml')
  const skill = read(
    'src-tauri/resources/agent-skills/downloads-organizer/SKILL.md'
  )

  for (const value of [
    'downloads_agent_acceptance',
    'Qwen3.5-9B-Q4_K_M.gguf',
    'Qwen3.8-27B-Q4_K_M.gguf',
    'ATOMIC_AGENT_E2E_MODEL_ID',
    'downloads-organizer',
    'restrict_to_yorebot_catalog: true',
    'AgentSessionState::new("downloads-agent-acceptance")',
    'assert_no_mutating_tools',
    'assert_allow_once_requests',
    'assert_snapshot',
    'undo',
    'denied',
  ]) {
    assert.ok(harness.includes(value), `missing Downloads Agent guard: ${value}`)
  }
  assert.doesNotMatch(harness, /IQ4_XS|turbo3/)
  assert.match(script, /\[switch\] \$RunDownloadsAgentAcceptance/)
  assert.match(script, /ATOMIC_AGENT_E2E_LLAMA_SERVER/)
  assert.match(script, /ATOMIC_AGENT_E2E_MODEL/)
  assert.match(script, /downloads_agent_acceptance/)
  assert.match(harness, /run_turn_with_completion_deadline/)
  assert.match(harness, /PRODUCTION_TOOL_STEP_COMPLETION_DEADLINE/)
  assert.match(runner, /TEST_TOOL_STEP_COMPLETION_DEADLINE/)
  assert.match(runner, /Duration::from_millis\(100\)/)
  assert.match(runner, /Duration::from_secs\(180\)/)
  assert.match(harness, /detect_model_profile/)
  assert.match(harness, /build_stable_prefix_for_profile/)
  assert.doesNotMatch(harness, /"--threads"/)
  assert.match(workflow, /core::agent::grammar::tests::/)
  assert.ok(
    script.indexOf('$PSNativeCommandUseErrorActionPreference = $true') <
      script.indexOf('downloads_agent_acceptance')
  )
  assert.match(harness, /"-ngl",\s*"0"/)
  assert.match(workflow, /-RunDownloadsAgentAcceptance/)
  assert.ok(
    workflow.indexOf('- name: Test product seams') <
      workflow.indexOf('- name: Verify Downloads Agent on pinned model')
  )
  assert.match(skill, /Do not mutate anything in the same step as the proposal/)
  assert.match(skill, /Every mutation must reach YoreBot's approval dialog/)
  assert.match(skill, /Use `\.` for the connected root and relative child paths/)
  assert.match(harness, /Call `os\.fs\.list` exactly once/)
  assert.match(harness, /assert_tool_string_arg\(&plan, "os\.fs\.list", "path", "\."\)/)
  assert.match(harness, /Use only these relative paths: `quarterly-report\.pdf`/)
  assert.doesNotMatch(
    `${script}\n${harness}\n${workflow}`,
    /tokens?\s*(\/|per)\s*second|throughput|benchmark/i
  )
})

test('heavy model smoke is manual-only while installer smoke stays on PR builds', () => {
  const internal = read('.github/workflows/windows-internal.yml')
  const installerUpload = internal.indexOf('- uses: actions/upload-artifact@v4')
  const installerSmoke = internal.indexOf('- name: Smoke fresh NSIS install and uninstall')
  const agentSmoke = internal.indexOf(
    '- name: Verify Downloads Agent on pinned model and CPU runtime'
  )
  const productSeams = internal.slice(
    internal.indexOf('- name: Test product seams'),
    internal.indexOf('- name: Build unsigned internal NSIS installer')
  )

  assert.match(internal, /^\s*pull_request:\s*$/m)
  assert.match(internal, /test-windows-installer\.ps1/)
  assert.match(internal, /node --test scripts\/tests\/windows-acceptance-contracts\.test\.mjs/)
  assert.match(internal, /test-windows-pinned-model\.ps1 -ValidateManifestOnly/)
  assert.match(
    internal,
    /tauri-plugin-llamacpp-upstream\/Cargo\.toml binary_version/
  )
  assert.match(internal, /Pinned runtime --version output/)
  assert.match(internal, /versionExitCode -ne 0/)
  assert.match(productSeams, /\$PSNativeCommandUseErrorActionPreference = \$true/)
  assert.ok(installerUpload >= 0 && installerUpload < installerSmoke)
  assert.match(internal.slice(installerUpload, installerSmoke), /if: always\(\)/)
  assert.ok(agentSmoke > installerSmoke)
  assert.match(
    internal.slice(agentSmoke, agentSmoke + 500),
    /if: github\.event_name == 'workflow_dispatch'/
  )
  assert.match(internal, /test-windows-pinned-model\.ps1 .* -RunDownloadsAgentAcceptance/)
  assert.doesNotMatch(internal, /^\s{2}pinned-model-smoke:\s*$/m)
  assert.equal(
    existsSync(resolve(root, '.github/workflows/windows-pinned-model-smoke.yml')),
    false
  )
})

test('installed Organize my Downloads binds the OS folder and proves visible safe mutations', () => {
  const home = read('web-app/src/routes/index.tsx')
  const messages = read('web-app/src/containers/MessageItem.tsx')
  const locale = read('web-app/src/locales/en/chat.json')
  const script = read('scripts/test-windows-first-use.ps1')
  const workflow = read('.github/workflows/windows-internal.yml')

  const selectTask = home.indexOf('async (prompt: string, skillName: string)')
  const resolveDownloads = home.indexOf('const downloadsPath = await downloadDir()', selectTask)
  const resolveRoot = home.indexOf('resolveAgentWorkspaceRoot(downloadsPath)', resolveDownloads)
  const setRoot = home.indexOf('.setPrimaryRoot(TEMPORARY_CHAT_ID', resolveRoot)
  const setPrompt = home.indexOf('setPrompt(prompt)', setRoot)
  assert.ok(
    selectTask >= 0 &&
      resolveDownloads > selectTask &&
      resolveRoot > resolveDownloads &&
      setRoot > resolveRoot &&
      setPrompt > setRoot,
    'the actual suggestion must connect Downloads before filling its prompt'
  )
  assert.match(home, /toast\.error\(t\('chat:agentTasks\.organizeDownloads\.unavailable'\)\)[\s\S]*?return/)
  assert.match(locale, /"unavailable":\s*"YoreBot couldn't open your Downloads folder\. Nothing was changed\."/)
  assert.match(locale, /"approveOnce":\s*"Approve once"/)
  assert.match(messages, /aria-label=\{[\s\S]*?'YoreBot reply text'/)
  assert.match(messages, /aria-label="Agent run error"/)

  for (const value of [
    '{374DE290-123F-4565-9164-39C4925E467B}',
    'Get-WindowsDownloadsRegistration',
    'Set-WindowsDownloadsRegistration',
    "Join-Path $workRootFull 'Downloads'",
    'The isolated Downloads registration did not resolve to the test-owned root',
    'The original Downloads registration was not restored exactly',
    "button.innerText.trim() === 'Organize my Downloads'",
    "button.innerText.trim() === 'New Chat'",
    "location.pathname === '/'",
    "localStorage.getItem('agent-mode')",
    "workspaces?.['temporary-chat']?.primaryRoot",
    "skill -ceq '/downloads-organizer'",
    '-UseExistingPrompt',
    'Assert-DownloadsPlanProposal',
    '$ValidateDownloadsPlanContractOnly',
    "Create 'Documents' folder and move quarterly-report.pdf there",
    "Leave mystery.download in place",
    'Do not move quarterly-report.pdf into Documents',
    'Move quarterly-report.pdf nowhere; Documents is not appropriate',
    'Do not keep mystery.download untouched; move it too',
    'Move quarterly-report.pdf and mystery.download into Documents',
    'Create Documents and move quarterly-report.pdf and mystery.download there',
    'Move quarterly-report.pdf to Trash. Documents remains empty',
    'Create Documents for later. Move quarterly-report.pdf to Trash',
    'Move quarterly-report.pdf to Trash and create Documents',
    'Create Documents for later, then move quarterly-report.pdf to Trash',
    'Do not move mystery.download; keep mystery.download untouched',
    'Move quarterly-report.pdf → Documents/quarterly-report.pdf',
    'Assert-TextContainsExactPaths',
    'Assert-DownloadsUndoSummary',
    'Documents/quarterly-report.pdf → quarterly-report.pdf, mystery.download',
    'quarterly-report.pdf → Documents/quarterly-report.pdf, mystery.download',
    'Documents/quarterly-report.pdf → quarterly-report.pdf.bak, quarterly-report.pdf, mystery.download',
    'Restored quarterly-report.pdf → Documents/quarterly-report.pdf',
    'Restored Documents/quarterly-report.pdf → quarterly-report.pdf.bak',
    'Moved Documents/quarterly-report.pdf to quarterly-report.pdf.bak',
    'Documents/quarterly-report.pdf is not back at quarterly-report.pdf',
    'Did not move Documents/quarterly-report.pdf to quarterly-report.pdf',
    'The Downloads plan mutated disk before acceptance or approval',
    'Create folder: $documentsPath',
    'Move: $reportPath → $movedReportPath',
    "-ApprovalDecisions @('Approve once', 'Approve once')",
    'Move: $movedReportPath → $reportPath',
    "-ApprovalDecisions @('Approve once')",
    "-ApprovalDecisions @('Deny')",
    'Deny changed the Downloads disk state',
    'Remove-DownloadsFixture -Root $downloadsRoot',
    'Downloads did not return to its empty pre-test state',
  ]) {
    assert.ok(script.includes(value), `installed Downloads proof omits ${value}`)
  }
  assert.match(
    workflow,
    /test-windows-first-use\.ps1 -ValidateDownloadsPlanContractOnly/
  )

  const completedChat = script.indexOf(
    "throw 'Actual Chat UI did not complete with the expected local response marker'"
  )
  const newChat = script.indexOf(
    "button.innerText.trim() === 'New Chat'",
    completedChat
  )
  const homeRoute = script.indexOf("location.pathname === '/'", newChat)
  const exactTask = script.indexOf(
    "button.innerText.trim() === 'Organize my Downloads'"
  )
  const plan = script.indexOf('$planReply = Invoke-YoreBotAgentTurn', exactTask)
  const planSnapshot = script.indexOf(
    'The Downloads plan mutated disk before acceptance or approval',
    plan
  )
  const apply = script.indexOf('$applyReply = Invoke-YoreBotAgentTurn', planSnapshot)
  const planGate = script.slice(planSnapshot, apply)
  assert.match(planGate, /Assert-DownloadsPlanProposal -Value \$planReply/)
  assert.doesNotMatch(planGate, /Assert-TextContainsAll/)
  assert.match(
    script,
    /\(\?:Archives\|Images\|Audio\|Video\|Installers\)/
  )
  const undo = script.indexOf('$undoReply = Invoke-YoreBotAgentTurn', apply)
  const deny = script.indexOf('$denyReply = Invoke-YoreBotAgentTurn', undo)
  const denySnapshot = script.indexOf('Deny changed the Downloads disk state', deny)
  const networkAssert = script.indexOf('Assert-CdpNetworkAudit', denySnapshot)
  assert.ok(
    completedChat >= 0 &&
      newChat > completedChat &&
      homeRoute > newChat &&
      exactTask > homeRoute &&
      plan > exactTask &&
      planSnapshot > plan &&
      apply > planSnapshot &&
      undo > apply &&
      deny > undo &&
      denySnapshot > deny &&
      networkAssert > denySnapshot,
    'plan, apply, undo, deny, and network proof must remain one ordered installed UI ritual'
  )
  const turnHelper = script.slice(
    script.indexOf('function Invoke-YoreBotAgentTurn'),
    script.indexOf('\nif (-not (Test-Path -LiteralPath $installer')
  )
  assert.match(
    turnHelper,
    /ExpectedApprovalPreviews = @\(\)[\s\S]*?approvalIndex -ge \$ExpectedApprovalPreviews\.Count/
  )
  assert.match(
    script,
    /if \(\$downloadsFixtureActive[\s\S]*?Remove-DownloadsFixture -Root \$downloadsRoot/
  )
  const captureDownloadsRegistration = script.indexOf(
    '$downloadsRegistration = Get-WindowsDownloadsRegistration'
  )
  const isolateDownloadsRoot = script.indexOf(
    "$downloadsRoot = Join-Path $workRootFull 'Downloads'",
    captureDownloadsRegistration
  )
  const redirectDownloadsRegistration = script.indexOf(
    'Set-WindowsDownloadsRegistration',
    isolateDownloadsRoot
  )
  const installApp = script.indexOf('$install = Start-Process', redirectDownloadsRegistration)
  const cleanupFinally = script.lastIndexOf('} finally {')
  const restoreDownloadsRegistration = script.indexOf(
    'Set-WindowsDownloadsRegistration',
    cleanupFinally
  )
  const cleanupDownloadsFixture = script.indexOf(
    'Remove-DownloadsFixture -Root $downloadsRoot',
    restoreDownloadsRegistration
  )
  assert.ok(
    captureDownloadsRegistration >= 0 &&
      isolateDownloadsRoot > captureDownloadsRegistration &&
      redirectDownloadsRegistration > isolateDownloadsRoot &&
      installApp > redirectDownloadsRegistration &&
      cleanupFinally > installApp &&
      restoreDownloadsRegistration > cleanupFinally &&
      cleanupDownloadsFixture > restoreDownloadsRegistration,
    'the test must isolate Downloads before install and restore the exact registration before fixture cleanup'
  )
  assert.doesNotMatch(
    script,
    /Get-DownloadsSnapshot -Root \$downloadsRoot\) -cne '\[\]'\) \{\s*throw 'The operating system Downloads folder is not empty;/,
    'acceptance must not inspect or depend on the runner original Downloads contents'
  )
  assert.doesNotMatch(script, /Invoke-PinnedDownload|RunDownloadsAgentAcceptance/)

  const firstUse = workflow.indexOf(
    '- name: Verify installed automatic setup, Chat, and Downloads task'
  )
  const directHarness = workflow.indexOf(
    '- name: Verify Downloads Agent on pinned model and CPU runtime'
  )
  assert.ok(firstUse >= 0 && directHarness > firstUse)
  assert.match(
    workflow.slice(firstUse, directHarness),
    /if: github\.event_name == 'workflow_dispatch' && inputs\.hardware_profile == 'ordinary-16gb'[\s\S]*test-windows-first-use\.ps1/
  )
  assert.match(workflow, /@janhq\/web-app test[^\n]*src\/routes\/index\.test\.tsx/)
})

test('manual Windows first use drives installed automatic setup into real Chat', () => {
  const scriptPath = resolve(root, 'scripts/test-windows-first-use.ps1')
  assert.equal(existsSync(scriptPath), true, 'first-use script is missing')

  const script = read('scripts/test-windows-first-use.ps1')
  const workflow = read('.github/workflows/windows-internal.yml')
  const baseConfig = read('src-tauri/tauri.conf.json')
  const windowsConfig = read('src-tauri/tauri.windows.conf.json')
  const releaseWorkflow = read('.github/workflows/release.yml')
  const signedWorkflow = read('.github/workflows/windows-signed-candidate.yml')
  const setup = read('web-app/src/containers/YoreBotSetupScreen.tsx')
  const chatInput = read('web-app/src/containers/ChatInput.tsx')
  const threadRoute = read('web-app/src/routes/threads/$threadId.tsx')
  const messages = read('web-app/src/containers/MessageItem.tsx')
  const accessDialog = read('web-app/src/containers/dialogs/YoreBotAccessDialog.tsx')

  for (const value of [
    'http://127.0.0.1:',
    'aria-label="YoreBot setup"',
    'data-testid="chat-input"',
    'aria-label="YoreBot response"',
    'Reply with exactly YOREBOT_CHAT_OK.',
    "marker: reply.includes('YOREBOT_CHAT_OK')",
    'Qwen3.5-9B-Q4_K_M',
    '3885219b6810b007914f3a7950a8d1b469d598a5',
    'sizeBytes: 5_680_522_464',
    '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
    'Bundled llama.cpp backend ready during startup: b10431/win-cpu-x64',
    'resources/stop-yorebot-owned-processes.ps1',
    'llamacpp-upstream/backends/b10431/win-cpu-x64',
    'llamacpp-upstream/backends/b10431/win-vulkan-x64',
    'Active Chat runtime did not report exact build 10431',
    'DevToolsActivePort',
    'Get-NetTCPConnection',
    "Name = 'msedgewebview2.exe'",
    'YoreBot installed first-use Chat and Downloads UI acceptance passed',
  ]) {
    assert.ok(script.includes(value), `first-use proof omits ${value}`)
  }
  for (const property of [
    "PSObject.Properties['id']",
    "PSObject.Properties['error']",
    "PSObject.Properties['result']",
    "PSObject.Properties['exceptionDetails']",
    "PSObject.Properties['value']",
  ]) {
    assert.ok(script.includes(property), `strict CDP parse omits ${property}`)
  }
  const connectStart = script.indexOf('function Connect-YoreBotWebView')
  const connectEnd = script.indexOf('\nif (-not (Test-Path -LiteralPath $installer', connectStart)
  assert.ok(connectStart >= 0 && connectEnd > connectStart)
  const connect = script.slice(connectStart, connectEnd)
  assert.match(
    connect,
    /\$response = Invoke-RestMethod[\s\S]*?-TimeoutSec 3[\s\S]*?\$targets = @\(\s*foreach \(\$entry in \$response\) \{ \$entry \}\s*\)/,
    'Invoke-RestMethod JSON arrays must be explicitly enumerated before target filtering'
  )
  assert.match(
    connect,
    /\$socket = \[System\.Net\.WebSockets\.ClientWebSocket\]::new\(\)[\s\S]*?try \{[\s\S]*?\.ConnectAsync\([\s\S]*?\} catch \{[\s\S]*?\$socket\.Dispose\(\)/,
    'a failed CDP WebSocket handshake must dispose its owned socket before retrying'
  )
  assert.match(
    connect,
    /\[void\]\s+\$socket\.ConnectAsync\(/,
    'a successful CDP handshake must not leak VoidTaskResult into the function output'
  )
  assert.match(
    script,
    /function Invoke-CdpCommand[\s\S]*?\[void\]\s+\$Socket\.SendAsync\([\s\S]*?return Receive-CdpMessage/,
    'sending a CDP command must not leak VoidTaskResult ahead of its response'
  )
  assert.match(connect, /\$firstSocketError = ''/)
  assert.match(connect, /WebView2 first WebSocket diagnostic:/)
  assert.match(connect, /WebView2 target diagnostic:/)
  const edgeWebViewTarget = {
    type: 'webview',
    title: 'YoreBot',
    url: 'http://tauri.localhost/',
    webSocketDebuggerUrl:
      'ws://localhost:9229/devtools/page/0123456789ABCDEF',
  }
  const oneElementInvokeRestResponse = [edgeWebViewTarget]
  assert.deepEqual(
    Array.from(oneElementInvokeRestResponse, (entry) => entry),
    [edgeWebViewTarget]
  )
  assert.equal(edgeWebViewTarget.type, 'webview')
  assert.equal(new URL(edgeWebViewTarget.url).host, 'tauri.localhost')
  assert.match(
    connect,
    /@\('page', 'webview'\) -contains \$typeProperty\.Value/
  )
  assert.match(connect, /\$titleProperty\.Value -ceq 'YoreBot'/)
  assert.match(connect, /\$documentUri\.Host -ieq 'tauri\.localhost'/)
  assert.match(connect, /\$documentUri\.Host -ieq 'asset\.localhost'/)
  assert.match(connect, /if \(\$eligibleTargets\.Count -ne 1\)/)
  for (const field of ['type=', 'title=', 'url=', 'websocket=']) {
    assert.ok(connect.includes(field), `target diagnostic omits ${field}`)
  }
  assert.match(connect, /\$reportedUri\.AbsolutePath -notmatch '\^\/devtools\/page\//)
  assert.match(connect, /\$uriBuilder\.Host = '127\.0\.0\.1'/)
  assert.doesNotMatch(script, /^["']@\S/m)
  assert.match(script, /replies\.length > \$baselineReplyCount/)
  assert.match(
    script,
    /Add-YoreBotNetworkAuditProgram[\s\S]*-Path \$serverPath/
  )
  assert.doesNotMatch(script, /Stop-Process\s+-Name|taskkill/i)
  assert.doesNotMatch(script, /tokens?\s*(\/|per)\s*second|throughput|benchmark/i)
  assert.match(setup, /aria-label=["']YoreBot setup["']/)
  assert.match(chatInput, /aria-label=["']Send message["']/)
  assert.match(threadRoute, /aria-label=["']Chat generation error["']/)
  assert.match(messages, /aria-label=\{\s*message\.role === 'assistant'/)
  assert.match(script, /\$cdpPort = 9229/)
  assert.match(script, /Assert-LoopbackPortAvailable -Port \$cdpPort/)
  assert.match(script, /WebView2 selected target: \$lastTargetDiagnostic/)
  assert.match(
    script,
    /-DiagnosticContext "parent=\$parentId command_line=\$commandLine"/
  )
  assert.match(
    read('scripts/windows-network-audit.ps1'),
    /pid=\$\(\$Process\.Id\) path=\$canonicalPath destinations=\[\$destinations\]\$contextSuffix/
  )
  assert.doesNotMatch(script, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/)
  const configuredWindows = JSON.parse(windowsConfig)
  assert.equal(configuredWindows.app.windows.length, 1)
  const shippingBrowserArgs = configuredWindows.app.windows[0].additionalBrowserArgs
  for (const value of [
    '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection',
    '--autoplay-policy=no-user-gesture-required',
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=localhost,127.0.0.1,[::1],tauri.localhost,asset.localhost,ipc.localhost',
  ]) {
    assert.ok(shippingBrowserArgs.includes(value), `shipping WebView omits ${value}`)
  }
  for (const source of [baseConfig, windowsConfig, releaseWorkflow, signedWorkflow]) {
    assert.doesNotMatch(source, /remote-debugging-(?:address|port)/)
  }
  assert.doesNotMatch(
    shippingBrowserArgs,
    /disable-web-security|ignore-certificate-errors|no-sandbox/i
  )
  assert.match(accessDialog, /import \{ openUrl \} from '@tauri-apps\/plugin-opener'/)
  assert.match(accessDialog, /await openUrl\(url\)/)
  const marker = script.indexOf("marker: reply.includes('YOREBOT_CHAT_OK')")
  const completed = script.indexOf('$chatCompleted = $true')
  const stopApp = script.indexOf('Stop-ExactProcesses -Path $appPath', marker)
  assert.ok(marker >= 0 && completed > marker && stopApp > completed)
  assert.match(
    script.slice(marker, stopApp),
    /aria-label="Send message"[\s\S]*aria-label="Chat generation error"/
  )
  const uninstall = script.indexOf('$uninstall = Start-Process')
  const orphanCheck = script.indexOf('YoreBot llama-server survived uninstall')
  const pass = script.indexOf('$passed = $true')
  assert.ok(uninstall >= 0 && orphanCheck > uninstall && orphanCheck < pass)
  assert.match(
    script.slice(uninstall, pass),
    /\$serverProcess\.Refresh\(\)[\s\S]*\$serverProcess\.HasExited/
  )

  const firstUse = workflow.indexOf(
    '- name: Verify installed automatic setup, Chat, and Downloads task'
  )
  const installer = workflow.indexOf(
    '- name: Smoke fresh NSIS install and uninstall'
  )
  const agent = workflow.indexOf(
    '- name: Verify Downloads Agent on pinned model and CPU runtime'
  )
  const upload = workflow.indexOf('- uses: actions/upload-artifact@v4')
  const instrumentedBuild = workflow.indexOf(
    '- name: Build test-only first-use NSIS installer'
  )
  const instrumentedCleanup = workflow.indexOf(
    '- name: Delete test-only first-use installer'
  )
  assert.ok(
    upload >= 0 &&
      instrumentedBuild > upload &&
      firstUse > instrumentedBuild &&
      instrumentedCleanup > firstUse &&
      installer > instrumentedCleanup &&
      agent > installer
  )
  const acceptanceBuild = workflow.slice(instrumentedBuild, firstUse)
  for (const value of [
    'src-tauri/tauri.windows.conf.json',
    'additionalBrowserArgs',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9229',
    "@('--config', $configPath)",
    'first-use-artifacts',
  ]) {
    assert.ok(acceptanceBuild.includes(value), `acceptance build omits ${value}`)
  }
  assert.match(
    acceptanceBuild,
    /\$shippingBrowserArgs = \[string\]\$config\.app\.windows\[0\]\.additionalBrowserArgs[\s\S]*\$config\.app\.windows\[0\]\.additionalBrowserArgs = "\$shippingBrowserArgs \$testOnlyBrowserArgs"/
  )
  assert.match(
    acceptanceBuild,
    /\$testOnlyBrowserArgs = '--remote-debugging-address=127\.0\.0\.1 --remote-debugging-port=9229'/
  )
  assert.doesNotMatch(
    acceptanceBuild,
    /\$testOnlyBrowserArgs = '[^']*(?:msWebOOUI|autoplay-policy)/
  )
  assert.equal((workflow.match(/additionalBrowserArgs/g) ?? []).length, 2)
  assert.match(
    acceptanceBuild,
    /if: github\.event_name == 'workflow_dispatch' && inputs\.hardware_profile == 'ordinary-16gb'/
  )
  assert.match(
    workflow.slice(firstUse, firstUse + 1_200),
    /if: github\.event_name == 'workflow_dispatch' && inputs\.hardware_profile == 'ordinary-16gb'[\s\S]*first-use-artifacts[\s\S]*test-windows-first-use\.ps1/
  )
  assert.match(
    workflow.slice(instrumentedCleanup, installer),
    /if: always\(\) && github\.event_name == 'workflow_dispatch' && inputs\.hardware_profile == 'ordinary-16gb'[\s\S]*first-use-artifacts/
  )
  assert.match(
    workflow.slice(agent, agent + 300),
    /if: github\.event_name == 'workflow_dispatch'/
  )
  assert.doesNotMatch(workflow, /first_use_chat:/)
  assert.match(workflow, /timeout-minutes: 90/)
  assert.match(workflow, /YoreBotSetupScreen\.test\.tsx/)
})

test('signed Windows draft release is manual-only, OIDC-only, ordered, and fail-closed', () => {
  const signed = read('.github/workflows/windows-signed-candidate.yml')
  const internal = read('.github/workflows/windows-internal.yml')
  const blocked = read('.github/workflows/release.yml')
  const cargo = read('src-tauri/Cargo.toml')
  const preflightScript = read('scripts/validate-windows-draft-release.ps1')

  assert.match(signed, /^on:\n\s+workflow_dispatch:\s*$/m)
  assert.doesNotMatch(signed, /^\s+(push|pull_request|release|schedule):/m)
  assert.match(signed, /^\s+contents: write\s*$/m)
  assert.match(signed, /^\s+id-token: write\s*$/m)
  assert.match(signed, /^\s+environment: windows-production-signing\s*$/m)
  assert.match(signed, /confirmation:/)
  assert.match(signed, /draft_tag:/)
  assert.match(signed, /SIGN_AND_DRAFT_YOREBOT_WINDOWS_RELEASE/)
  assert.match(signed, /\$env:GITHUB_REF -cne 'refs\/heads\/yorebot-v2-base'/)
  assert.match(signed, /\$env:GITHUB_REPOSITORY -cne 'emv-dev\/YoreBot'/)
  assert.match(signed, /YOREBOT_DRAFT_TAG: \$\{\{ inputs\.draft_tag \}\}/)
  assert.match(signed, /YOREBOT_RELEASE_BASE_URL: https:\/\/github\.com\/emv-dev\/YoreBot\/releases\/download/)

  for (const variable of [
    'AZURE_CLIENT_ID',
    'AZURE_TENANT_ID',
    'AZURE_SUBSCRIPTION_ID',
    'AZURE_ARTIFACT_SIGNING_ENDPOINT',
    'AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME',
    'AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME',
    'YOREBOT_WINDOWS_SIGNER_SUBJECT',
    'YOREBOT_GUMROAD_PRODUCT_ID',
    'YOREBOT_GUMROAD_MONTHLY_CHECKOUT_URL',
    'YOREBOT_GUMROAD_YEARLY_CHECKOUT_URL',
    'YOREBOT_GUMROAD_MANAGE_URL',
  ]) {
    assert.match(signed, new RegExp(`vars\\.${variable}`), `missing variable: ${variable}`)
  }
  assert.doesNotMatch(signed, /secrets\.|AZURE_CLIENT_SECRET|\bcreds:/)
  assert.match(
    signed,
    /uses: actions\/checkout@[0-9a-f]{40}[\s\S]{0,200}persist-credentials: false/
  )

  const actionRefs = [...signed.matchAll(/^\s*- uses: [^@\s]+@([^\s#]+).*$/gm)]
    .map((match) => match[1])
  assert.ok(actionRefs.length > 0)
  for (const actionRef of actionRefs) {
    assert.match(actionRef, /^[0-9a-f]{40}$/, `mutable action ref: ${actionRef}`)
  }

  assert.match(
    signed,
    /azure\/login@7ddb5af1ef8758cf1353cf3b42f940aee27ba21c/
  )
  assert.equal(
    signed.match(/azure\/login@7ddb5af1ef8758cf1353cf3b42f940aee27ba21c/g)?.length,
    2
  )
  assert.match(
    signed,
    /azure\/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82/g
  )
  assert.equal(
    signed.match(/azure\/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82/g)?.length,
    2
  )

  const preflight = signed.indexOf('- name: Refuse unconfigured or unconfirmed signing')
  const validateRelease = signed.indexOf('- name: Validate draft tag and Gumroad build configuration')
  const login = signed.indexOf('- name: Azure OIDC login')
  const build = signed.indexOf('- name: Build release app without bundle')
  const signApp = signed.indexOf('- name: Sign main app executable')
  const clearAppSession = signed.indexOf('- name: Clear app-signing Azure session')
  const bundle = signed.indexOf('- name: Bundle signed NSIS candidate')
  const signInstaller = signed.indexOf('- name: Sign NSIS installer')
  const clearInstallerSession = signed.indexOf(
    '- name: Clear installer-signing Azure session'
  )
  const verify = signed.indexOf('- name: Verify signed candidate by fresh install')
  const draft = signed.indexOf('- name: Create and verify unpublished signed draft release')
  assert.ok(
    preflight >= 0 &&
      preflight < validateRelease &&
      validateRelease < build &&
      preflight < build &&
      build < login &&
      build < signApp &&
      login < signApp &&
      signApp < clearAppSession &&
      clearAppSession < bundle &&
      bundle < signInstaller &&
      signInstaller < clearInstallerSession &&
      clearInstallerSession < verify &&
      verify < draft
  )
  assert.match(cargo, /^default-run\s*=\s*"Atomic-Chat"\s*$/m)
  assert.match(signed, /files-folder-filter: Atomic-Chat\.exe/)
  assert.match(signed, /files-folder: \$\{\{ github\.workspace \}\}\\src-tauri\\target\\release\\bundle\\nsis/)
  assert.equal(
    signed.match(/exclude-azure-cli-credential: false/g)?.length,
    2
  )
  assert.equal(
    signed.match(/exclude-interactive-browser-credential: true/g)?.length,
    2
  )
  assert.match(signed, /tauri build --no-bundle --ci/)
  assert.match(signed, /tauri bundle --bundles nsis --ci/)
  const bundleBlock = signed.slice(bundle, signInstaller)
  assert.match(bundleBlock, /\$env:YOREBOT_DRAFT_TAG -cne "yorebot-v\$appVersion"/)
  assert.doesNotMatch(bundleBlock, /\$tag -cne "yorebot-v\$appVersion"/)
  assert.match(signed.slice(validateRelease, build), /validate-windows-draft-release\.ps1/)
  assert.match(signed.slice(build, login), /YOREBOT_GUMROAD_PRODUCT_ID/)
  assert.match(signed.slice(build, login), /Assert-BytesContain/)
  assert.doesNotMatch(signed, /upload-artifact|retention-days|msix/i)

  const beforeDraft = signed.slice(0, draft)
  const draftBlock = signed.slice(draft)
  assert.doesNotMatch(beforeDraft, /GH_TOKEN|github\.token/)
  assert.match(draftBlock, /GH_TOKEN: \$\{\{ github\.token \}\}/)
  assert.equal((signed.match(/GH_TOKEN:/g) ?? []).length, 1)
  assert.match(draftBlock, /\$repositoryApi = "https:\/\/api\.github\.com\/repos\/\$env:GITHUB_REPOSITORY"/)
  assert.match(draftBlock, /-Uri "\$repositoryApi\/releases"[\s\S]{0,160}-Method POST/)
  assert.equal(
    draftBlock.match(/-Uri "\$repositoryApi\/releases"[\s\S]{0,160}-Method POST/g)?.length,
    1
  )
  assert.equal(
    draftBlock.match(/-Uri "\$repositoryApi\/git\/refs"[\s\S]{0,160}-Method POST/g)?.length,
    1
  )
  const tagCreate = draftBlock.indexOf('-Uri "$repositoryApi/git/refs"')
  const tagOwned = draftBlock.indexOf('$tagCreatedByRun = $true')
  const releaseCreate = draftBlock.indexOf('-Uri "$repositoryApi/releases"')
  const tagDelete = draftBlock.indexOf('-Uri "$repositoryApi/git/refs/tags/$encodedTag"')
  assert.ok(tagCreate >= 0 && tagCreate < tagOwned && tagOwned < releaseCreate && releaseCreate < tagDelete)
  assert.match(draftBlock.slice(tagCreate, tagOwned), /-ExpectedStatus 201/)
  assert.match(draftBlock.slice(tagCreate, tagOwned), /\$createdTagRef\.object\.type -cne 'commit'/)
  assert.match(draftBlock.slice(tagCreate, tagOwned), /\$createdTagRef\.object\.sha -cne \$env:GITHUB_SHA/)
  assert.match(draftBlock, /target_commitish = \$env:GITHUB_SHA/)
  assert.match(draftBlock, /draft = \$true/)
  assert.match(draftBlock, /\$releaseName = "YoreBot \$appVersion for Windows"/)
  assert.match(draftBlock, /\$releaseBody = "Private local Chat and a Downloads task that asks before changing files/)
  assert.match(draftBlock, /<!-- YOREBOT_DRAFT_OWNER run=/)
  assert.match(draftBlock, /\.sha256/)
  assert.match(draftBlock, /assets\.Count -ne 2/)
  assert.match(draftBlock, /browser_download_url/)
  assert.match(draftBlock, /\[string\]\$asset\.digest -cne \$expectedAsset\.Digest/)
  assert.match(draftBlock, /Digest = "sha256:\$installerHash"/)
  assert.match(draftBlock, /Digest = "sha256:\$checksumHash"/)
  assert.match(draftBlock, /Dictionary\[string, object\].*StringComparer\]::Ordinal/s)
  assert.match(draftBlock, /YOREBOT_RELEASE_BASE_URL/)
  assert.match(draftBlock, /Get-AuthenticodeSignature/)
  assert.match(draftBlock, /TimeStamperCertificate/)
  assert.match(draftBlock, /\$createdReleaseId/)
  assert.match(draftBlock, /\$tagCreationAttempted = \$true/)
  assert.match(draftBlock, /\$releaseCreationAttempted = \$true/)
  assert.match(draftBlock, /\$recordedReleaseId = \$createdReleaseId/)
  assert.match(draftBlock, /\$release\.upload_url\)/)
  assert.doesNotMatch(draftBlock, /\$release\.upload_url\s*\|\s*Out-String/)
  assert.match(draftBlock, /Invoke-WebRequest @request/)
  assert.match(draftBlock, /-InFile \(\[string\]\$asset\.Path\)/)
  assert.match(preflightScript, /https:\/\/uploads\.github\.com\/repos\/\$RepositoryName\/releases\/\$ExactReleaseId\/assets/)
  assert.doesNotMatch(draftBlock, /api\.uploads\.github\.com/)
  assert.match(draftBlock, /\$releaseProbe = Invoke-GitHubRequest -Uri "\$repositoryApi\/releases\/tags\/\$encodedTag"/)
  assert.match(draftBlock, /\$tagProbe = Invoke-GitHubRequest -Uri "\$repositoryApi\/git\/ref\/tags\/\$encodedTag"/)
  assert.match(draftBlock, /release ownership probe transport/)
  assert.match(draftBlock, /tag ownership probe transport/)
  assert.match(draftBlock, /\$ownedRelease\.name -cne \$releaseName/)
  assert.match(draftBlock, /\$ownedRelease\.body -cne \$releaseBody/)
  assert.match(draftBlock, /\$ownedRelease\.id -ne \$recordedReleaseId/)
  assert.match(draftBlock, /\$ownedRelease\.target_commitish -cne \$env:GITHUB_SHA/)
  assert.match(draftBlock, /\$ownedTag\.object\.sha -cne \$env:GITHUB_SHA/)
  assert.match(draftBlock, /\$tagCreatedByRun -and\s+\$releaseStateSafeForTagCleanup/)
  assert.match(draftBlock, /tag creation response did not prove ownership/)
  assert.match(draftBlock, /-Uri "\$repositoryApi\/releases\/\$\(\[long\]\$ownedRelease\.id\)"/)
  assert.match(draftBlock, /-Uri "\$repositoryApi\/git\/refs\/tags\/\$encodedTag"/)
  assert.match(draftBlock, /Draft release failed and cleanup was incomplete/)
  assert.doesNotMatch(draftBlock, /\$createdTag\s*=|--latest|--prerelease|gh release|gh api/)

  for (const value of [
    '[switch] $ValidateContractOnly',
    "'yorebot-v$version'",
    "'https'",
    "'monthly'",
    "'yearly'",
    "'/library'",
    'same Gumroad product',
    'existing tag',
    'existing release',
    'uploads.github.com',
    'api.uploads.github.com',
    'assets{?name,label}`n',
  ]) {
    assert.ok(preflightScript.includes(value), `missing draft preflight contract: ${value}`)
  }
  for (const unsafeTag of [
    'v2.0.0',
    'yorebot-v2.0.1',
    'yorebot-v2.0.0-beta.1',
  ]) {
    assert.ok(preflightScript.includes(unsafeTag), `missing rejected tag fixture: ${unsafeTag}`)
  }
  assert.match(preflightScript, /\$gumroadHost = \$uri\.DnsSafeHost\.ToLowerInvariant\(\)/)
  assert.doesNotMatch(preflightScript, /^\s*\$host\s*=/mi)
  assert.match(
    internal,
    /validate-windows-draft-release\.ps1 -ValidateContractOnly/
  )
  assert.match(internal, /scripts\/validate-windows-draft-release\.ps1/)

  assert.match(blocked, /^on:\n\s+workflow_dispatch:\s*$/m)
  assert.match(blocked, /^\s+contents: read\s*$/m)
  assert.match(blocked, /Refuse an unsigned public release/)
  assert.match(blocked, /exit 1/)
  assert.doesNotMatch(blocked, /id-token: write|contents: write/)
})

test('signed installer smoke requires valid exact timestamped signatures', () => {
  const script = read('scripts/test-windows-installer.ps1')

  for (const value of [
    '[string] $ExpectedSignerSubject',
    'Get-AuthenticodeSignature',
    "Status -ne 'Valid'",
    'SignerCertificate.Subject -cne $ExpectedSignerSubject',
    'TimeStamperCertificate',
    'Assert-AuthenticodeSignature -Path $installer',
    'Assert-AuthenticodeSignature -Path $appPath',
  ]) {
    assert.ok(script.includes(value), `missing signature guard: ${value}`)
  }
  assert.ok(
    script.indexOf('Assert-AuthenticodeSignature -Path $installer') <
      script.indexOf('$install = Start-Process')
  )
  assert.ok(
    script.indexOf('Assert-AuthenticodeSignature -Path $appPath') >
      script.indexOf("if (-not (Test-Path -LiteralPath $uninstallKey))")
  )
})

test('Windows signing setup documents the human-only Azure and draft boundary', () => {
  const doc = read('docs/WINDOWS_SIGNING.md')

  for (const value of [
    'windows-production-signing',
    'repo:emv-dev@4650476/YoreBot@1350153489:environment:windows-production-signing',
    'gh api repos/emv-dev/YoreBot',
    'restrict deployment branches to `yorebot-v2-base` only',
    'Artifact Signing Certificate Profile Signer',
    'AZURE_CLIENT_ID',
    'AZURE_TENANT_ID',
    'AZURE_SUBSCRIPTION_ID',
    'AZURE_ARTIFACT_SIGNING_ENDPOINT',
    'AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME',
    'AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME',
    'YOREBOT_WINDOWS_SIGNER_SUBJECT',
    'YOREBOT_GUMROAD_PRODUCT_ID',
    'YOREBOT_GUMROAD_MONTHLY_CHECKOUT_URL',
    'YOREBOT_GUMROAD_YEARLY_CHECKOUT_URL',
    'YOREBOT_GUMROAD_MANAGE_URL',
    'SIGN_AND_DRAFT_YOREBOT_WINDOWS_RELEASE',
    'yorebot-v2.0.0',
  ]) {
    assert.ok(doc.includes(value), `missing signing setup boundary: ${value}`)
  }
  assert.match(doc, /OIDC/i)
  assert.match(doc, /cost|billing|charge/i)
  assert.match(doc, /does not create|will not create/i)
  assert.match(doc, /draft|unpublished/i)
  assert.match(doc, /publishing[\s\S]{0,80}separate|does not publish|never publishes/i)
  assert.match(doc, /public repository/i)
  assert.match(doc, /does not upload/i)
  assert.match(doc, /server-reported\s+SHA-256 digests/i)
  assert.match(doc, /hidden run marker/i)
  assert.match(doc, /contents: write.*throughout/is)
  assert.match(doc, /only the final shell step receives `GH_TOKEN`/i)
  assert.doesNotMatch(doc, /client secret/i)
})

test('every multi-command PowerShell workflow step fails fast', () => {
  for (const workflow of [
    '.github/workflows/windows-internal.yml',
    '.github/workflows/windows-signed-candidate.yml',
  ]) {
    const blocks = multilinePwshBlocks(read(workflow))
    assert.ok(blocks.length > 0)
    for (const { name, statements } of blocks) {
      assert.equal(
        statements[0].trim(),
        "$ErrorActionPreference = 'Stop'",
        `${workflow}: ${name} must set terminating PowerShell errors first`
      )
      assert.equal(
        statements[1].trim(),
        '$PSNativeCommandUseErrorActionPreference = $true',
        `${workflow}: ${name} must fail on native command errors before doing work`
      )
    }
  }
})
