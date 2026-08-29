use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const ENTITLEMENTS_FILE: &str = "yorebot-entitlements.json";
const ENTITLEMENTS_VERSION: u32 = 2;
const MAX_ENTITLEMENTS_BYTES: u64 = 256 * 1024;
pub const FREE_AGENT_TOKENS_PER_DAY: u64 = 2_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct DailyAgentUsage {
    day_utc: String,
    tokens: u64,
}

impl Default for DailyAgentUsage {
    fn default() -> Self {
        Self {
            day_utc: String::new(),
            tokens: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct EntitlementFile {
    version: u32,
    #[serde(default)]
    permanent_model_packs: BTreeSet<String>,
    #[serde(default)]
    agent_usage: DailyAgentUsage,
}

impl Default for EntitlementFile {
    fn default() -> Self {
        Self {
            version: ENTITLEMENTS_VERSION,
            permanent_model_packs: BTreeSet::new(),
            agent_usage: DailyAgentUsage::default(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct LegacyEntitlementFileV1 {
    version: u32,
    #[serde(default)]
    permanent_model_packs: BTreeSet<String>,
    #[serde(default)]
    agent_usage: DailyAgentUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentAccessTier {
    Subscription,
    PermanentModelPack,
    Free,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentAccess {
    pub allowed: bool,
    pub tier: AgentAccessTier,
    pub day_tokens: u64,
    pub daily_limit: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentTokenUsage {
    pub prompt_tokens: u64,
    pub predicted_tokens: u64,
}

impl AgentTokenUsage {
    pub fn total(self) -> u64 {
        self.prompt_tokens.saturating_add(self.predicted_tokens)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentUsageReceipt {
    pub step_tokens: u64,
    pub day_tokens: u64,
    pub daily_limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntitlementGrant {
    PermanentModelPack(String),
}

#[derive(Debug, Default)]
pub struct EntitlementStore {
    data_folder: Option<PathBuf>,
    state: EntitlementFile,
    verified_subscription: bool,
}

impl EntitlementStore {
    pub fn load_for_data_folder(&mut self, data_folder: &Path) -> Result<(), String> {
        if self.data_folder.as_deref() == Some(data_folder) {
            return Ok(());
        }
        let path = data_folder.join(ENTITLEMENTS_FILE);
        let (state, migrated) = if path.exists() {
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("Failed to inspect YoreBot entitlements: {error}"))?;
            if metadata.len() > MAX_ENTITLEMENTS_BYTES {
                return Err("YoreBot entitlements file is too large".into());
            }
            let bytes = fs::read(&path)
                .map_err(|error| format!("Failed to read YoreBot entitlements: {error}"))?;
            let value: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|error| format!("Invalid YoreBot entitlements: {error}"))?;
            match value.get("version").and_then(serde_json::Value::as_u64) {
                Some(1) => {
                    let legacy: LegacyEntitlementFileV1 = serde_json::from_value(value)
                        .map_err(|error| format!("Invalid YoreBot entitlements: {error}"))?;
                    debug_assert_eq!(legacy.version, 1);
                    (
                        EntitlementFile {
                            version: ENTITLEMENTS_VERSION,
                            permanent_model_packs: legacy.permanent_model_packs,
                            agent_usage: legacy.agent_usage,
                        },
                        true,
                    )
                }
                Some(version) if version == u64::from(ENTITLEMENTS_VERSION) => (
                    serde_json::from_value(value)
                        .map_err(|error| format!("Invalid YoreBot entitlements: {error}"))?,
                    false,
                ),
                Some(version) => {
                    return Err(format!(
                        "Unsupported YoreBot entitlements version: {version}"
                    ))
                }
                None => return Err("Invalid YoreBot entitlements version".into()),
            }
        } else {
            (EntitlementFile::default(), false)
        };
        self.state = state;
        self.data_folder = Some(data_folder.to_path_buf());
        if migrated {
            self.persist()?;
        }
        Ok(())
    }

    pub fn check_at(
        &mut self,
        data_folder: &Path,
        model_id: &str,
        now: DateTime<Utc>,
    ) -> Result<AgentAccess, String> {
        self.load_for_data_folder(data_folder)?;
        if self.normalize_day(now) {
            self.persist()?;
        }
        Ok(self.access(model_id))
    }

    pub fn record_at(
        &mut self,
        data_folder: &Path,
        model_id: &str,
        usage: AgentTokenUsage,
        now: DateTime<Utc>,
    ) -> Result<AgentUsageReceipt, String> {
        let access = self.check_at(data_folder, model_id, now)?;
        self.state.agent_usage.tokens = self.state.agent_usage.tokens.saturating_add(usage.total());
        self.persist()?;
        Ok(AgentUsageReceipt {
            step_tokens: usage.total(),
            day_tokens: self.state.agent_usage.tokens,
            daily_limit: access.daily_limit,
        })
    }

    pub fn apply_grant(
        &mut self,
        data_folder: &Path,
        grant: EntitlementGrant,
    ) -> Result<(), String> {
        self.load_for_data_folder(data_folder)?;
        match grant {
            EntitlementGrant::PermanentModelPack(model_id) => {
                self.state.permanent_model_packs.insert(model_id);
            }
        }
        self.persist()
    }

    pub fn set_verified_subscription(&mut self, active: bool) {
        self.verified_subscription = active;
    }

    pub fn has_verified_subscription(&self) -> bool {
        self.verified_subscription
    }

    fn access(&self, model_id: &str) -> AgentAccess {
        let tier = if self.verified_subscription {
            AgentAccessTier::Subscription
        } else if self.state.permanent_model_packs.contains(model_id) {
            AgentAccessTier::PermanentModelPack
        } else {
            AgentAccessTier::Free
        };
        let daily_limit = matches!(
            tier,
            AgentAccessTier::Free | AgentAccessTier::PermanentModelPack
        )
        .then_some(FREE_AGENT_TOKENS_PER_DAY);
        AgentAccess {
            allowed: daily_limit.is_none_or(|limit| self.state.agent_usage.tokens < limit),
            tier,
            day_tokens: self.state.agent_usage.tokens,
            daily_limit,
        }
    }

    fn normalize_day(&mut self, now: DateTime<Utc>) -> bool {
        let day = now.date_naive().to_string();
        if self.state.agent_usage.day_utc == day {
            return false;
        }
        self.state.agent_usage = DailyAgentUsage {
            day_utc: day,
            tokens: 0,
        };
        true
    }

    fn persist(&self) -> Result<(), String> {
        let data_folder = self
            .data_folder
            .as_ref()
            .ok_or("YoreBot entitlements data folder is not loaded")?;
        fs::create_dir_all(data_folder)
            .map_err(|error| format!("Failed to create YoreBot data folder: {error}"))?;
        let destination = data_folder.join(ENTITLEMENTS_FILE);
        let temporary =
            data_folder.join(format!("{ENTITLEMENTS_FILE}.{}.tmp", uuid::Uuid::new_v4()));
        let content = serde_json::to_vec_pretty(&self.state)
            .map_err(|error| format!("Failed to serialize YoreBot entitlements: {error}"))?;
        let result = (|| {
            let mut file = fs::File::create(&temporary)
                .map_err(|error| format!("Failed to create YoreBot entitlements: {error}"))?;
            file.write_all(&content)
                .map_err(|error| format!("Failed to write YoreBot entitlements: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("Failed to sync YoreBot entitlements: {error}"))?;
            drop(file);
            atomic_replace(&temporary, &destination)
                .map_err(|error| format!("Failed to commit YoreBot entitlements: {error}"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

pub type SharedEntitlementStore = Arc<Mutex<EntitlementStore>>;

#[async_trait]
pub trait AgentQuotaHook: Send + Sync {
    async fn check(&self) -> Result<AgentAccess, String>;
    async fn record(&self, usage: AgentTokenUsage) -> Result<AgentUsageReceipt, String>;
}

pub struct LocalEntitlementGate {
    store: SharedEntitlementStore,
    data_folder: PathBuf,
    model_id: String,
}

impl LocalEntitlementGate {
    pub fn new(
        store: SharedEntitlementStore,
        data_folder: &Path,
        model_id: impl Into<String>,
    ) -> Self {
        Self {
            store,
            data_folder: data_folder.to_path_buf(),
            model_id: model_id.into(),
        }
    }
}

#[async_trait]
impl AgentQuotaHook for LocalEntitlementGate {
    async fn check(&self) -> Result<AgentAccess, String> {
        self.store
            .lock()
            .await
            .check_at(&self.data_folder, &self.model_id, Utc::now())
    }

    async fn record(&self, usage: AgentTokenUsage) -> Result<AgentUsageReceipt, String> {
        self.store
            .lock()
            .await
            .record_at(&self.data_folder, &self.model_id, usage, Utc::now())
    }
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let ok = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tempfile::TempDir;

    fn at(day: u32, hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, day, hour, 0, 0)
            .single()
            .unwrap()
    }

    #[test]
    fn fresh_user_is_free_without_local_paid_authority() {
        let temp = TempDir::new().unwrap();
        let mut store = EntitlementStore::default();
        let fresh = store.check_at(temp.path(), "model-a", at(1, 0)).unwrap();
        assert_eq!(fresh.tier, AgentAccessTier::Free);
        assert_eq!(fresh.daily_limit, Some(FREE_AGENT_TOKENS_PER_DAY));
        assert!(!store.has_verified_subscription());
    }

    #[test]
    fn crafted_local_paid_fields_cannot_unlock_agent() {
        let temp = TempDir::new().unwrap();
        fs::write(
            temp.path().join(ENTITLEMENTS_FILE),
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "trial_started_at": "2026-08-01T00:00:00Z",
                "subscription_expires_at": "2099-01-01T00:00:00Z",
                "permanent_model_packs": ["model-a"],
                "agent_usage": {
                    "day_utc": "2026-08-01",
                    "tokens": FREE_AGENT_TOKENS_PER_DAY
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let mut store = EntitlementStore::default();
        let access = store.check_at(temp.path(), "model-a", at(1, 1)).unwrap();

        assert_eq!(access.tier, AgentAccessTier::PermanentModelPack);
        assert_eq!(access.daily_limit, Some(FREE_AGENT_TOKENS_PER_DAY));
        assert!(!access.allowed);
        let migrated: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join(ENTITLEMENTS_FILE)).unwrap())
                .unwrap();
        assert_eq!(migrated["version"], ENTITLEMENTS_VERSION);
        assert!(migrated.get("trial_started_at").is_none());
        assert!(migrated.get("subscription_expires_at").is_none());
        assert_eq!(migrated["agent_usage"]["tokens"], FREE_AGENT_TOKENS_PER_DAY);
    }

    #[test]
    fn crafted_v2_paid_fields_are_ignored_and_never_rewritten() {
        let temp = TempDir::new().unwrap();
        fs::write(
            temp.path().join(ENTITLEMENTS_FILE),
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": ENTITLEMENTS_VERSION,
                "trial_started_at": "2026-08-01T00:00:00Z",
                "subscription_expires_at": "2099-01-01T00:00:00Z",
                "permanent_model_packs": [],
                "agent_usage": { "day_utc": "2026-08-01", "tokens": 0 }
            }))
            .unwrap(),
        )
        .unwrap();

        let access = EntitlementStore::default()
            .check_at(temp.path(), "model-a", at(1, 1))
            .unwrap();

        assert_eq!(access.tier, AgentAccessTier::Free);
        assert_eq!(access.daily_limit, Some(FREE_AGENT_TOKENS_PER_DAY));
    }

    #[test]
    fn gates_free_agent_after_daily_usage_and_resets_next_utc_day() {
        let temp = TempDir::new().unwrap();
        let mut store = EntitlementStore::default();
        let now = at(1, 1);
        store
            .record_at(
                temp.path(),
                "model-a",
                AgentTokenUsage {
                    prompt_tokens: FREE_AGENT_TOKENS_PER_DAY - 1,
                    predicted_tokens: 1,
                },
                now,
            )
            .unwrap();
        assert!(!store.check_at(temp.path(), "model-a", now).unwrap().allowed);
        assert!(
            store
                .check_at(temp.path(), "model-a", at(2, 0))
                .unwrap()
                .allowed
        );
    }

    #[test]
    fn permanent_model_pack_keeps_the_free_agent_limit() {
        let temp = TempDir::new().unwrap();
        let mut store = EntitlementStore::default();
        store
            .apply_grant(
                temp.path(),
                EntitlementGrant::PermanentModelPack("model-a".into()),
            )
            .unwrap();
        let owned = store.check_at(temp.path(), "model-a", at(1, 0)).unwrap();
        assert_eq!(owned.tier, AgentAccessTier::PermanentModelPack);
        assert_eq!(owned.daily_limit, Some(FREE_AGENT_TOKENS_PER_DAY));

        store
            .record_at(
                temp.path(),
                "model-a",
                AgentTokenUsage {
                    prompt_tokens: FREE_AGENT_TOKENS_PER_DAY,
                    predicted_tokens: 0,
                },
                at(1, 0),
            )
            .unwrap();
        let gated = store.check_at(temp.path(), "model-a", at(1, 1)).unwrap();
        assert_eq!(gated.tier, AgentAccessTier::PermanentModelPack);
        assert!(!gated.allowed);
    }

    #[test]
    fn only_process_verified_subscription_bypasses_the_agent_limit() {
        let temp = TempDir::new().unwrap();
        let mut store = EntitlementStore::default();
        store
            .apply_grant(
                temp.path(),
                EntitlementGrant::PermanentModelPack("model-a".into()),
            )
            .unwrap();
        store
            .record_at(
                temp.path(),
                "model-a",
                AgentTokenUsage {
                    prompt_tokens: FREE_AGENT_TOKENS_PER_DAY,
                    predicted_tokens: 0,
                },
                at(1, 0),
            )
            .unwrap();
        assert!(
            !store
                .check_at(temp.path(), "model-a", at(1, 0))
                .unwrap()
                .allowed
        );

        store.set_verified_subscription(true);
        let subscription = store.check_at(temp.path(), "model-a", at(1, 0)).unwrap();
        assert_eq!(subscription.tier, AgentAccessTier::Subscription);
        assert_eq!(subscription.daily_limit, None);
        assert!(subscription.allowed);

        store.set_verified_subscription(false);
        let free_again = store.check_at(temp.path(), "model-a", at(1, 0)).unwrap();
        assert_eq!(free_again.tier, AgentAccessTier::PermanentModelPack);
        assert!(!free_again.allowed);
    }

    #[test]
    fn persists_usage_and_fails_closed_on_corrupt_state() {
        let temp = TempDir::new().unwrap();
        let mut store = EntitlementStore::default();
        store
            .record_at(
                temp.path(),
                "model-a",
                AgentTokenUsage {
                    prompt_tokens: 10,
                    predicted_tokens: 5,
                },
                at(1, 0),
            )
            .unwrap();
        let mut reloaded = EntitlementStore::default();
        assert_eq!(
            reloaded
                .check_at(temp.path(), "model-a", at(1, 1))
                .unwrap()
                .day_tokens,
            15
        );
        fs::write(temp.path().join(ENTITLEMENTS_FILE), b"not json").unwrap();
        assert!(EntitlementStore::default()
            .check_at(temp.path(), "model-a", at(1, 2))
            .is_err());
    }

    #[test]
    fn verified_subscription_is_process_only_and_never_serialized() {
        let temp = TempDir::new().unwrap();
        let mut store = EntitlementStore::default();
        store.set_verified_subscription(true);
        store
            .record_at(
                temp.path(),
                "model-a",
                AgentTokenUsage {
                    prompt_tokens: 10,
                    predicted_tokens: 5,
                },
                at(1, 0),
            )
            .unwrap();
        assert_eq!(
            store
                .check_at(temp.path(), "model-a", at(1, 1))
                .unwrap()
                .tier,
            AgentAccessTier::Subscription
        );

        let persisted = fs::read_to_string(temp.path().join(ENTITLEMENTS_FILE)).unwrap();
        assert!(!persisted.contains("subscription"));
        assert!(!persisted.contains("trial"));

        let access = EntitlementStore::default()
            .check_at(temp.path(), "model-a", at(1, 1))
            .unwrap();
        assert_eq!(access.tier, AgentAccessTier::Free);
        assert_eq!(access.day_tokens, 15);
    }
}
