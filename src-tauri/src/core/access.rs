use std::{future::Future, time::Duration};

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;
use url::Url;

use super::{agent::entitlements::SharedEntitlementStore, state::AppState};

const VERIFY_URL: &str = "https://api.gumroad.com/v2/licenses/verify";
#[cfg(target_os = "windows")]
const CREDENTIAL_SERVICE: &str = "YoreBot";
#[cfg(target_os = "windows")]
const CREDENTIAL_ACCOUNT: &str = "subscription-license";
const MAX_LICENSE_BYTES: usize = 256;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 64 * 1024;
const VERIFY_TIMEOUT: Duration = Duration::from_secs(12);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
static ACCESS_COMMANDS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(target_os = "windows")]
const PRODUCT_ID: Option<&str> = option_env!("YOREBOT_GUMROAD_PRODUCT_ID");
#[cfg(target_os = "windows")]
const MONTHLY_CHECKOUT_URL: Option<&str> = option_env!("YOREBOT_GUMROAD_MONTHLY_CHECKOUT_URL");
#[cfg(target_os = "windows")]
const YEARLY_CHECKOUT_URL: Option<&str> = option_env!("YOREBOT_GUMROAD_YEARLY_CHECKOUT_URL");
#[cfg(target_os = "windows")]
const MANAGE_URL: Option<&str> = option_env!("YOREBOT_GUMROAD_MANAGE_URL");

#[derive(Clone)]
struct AccessConfig {
    product_id: String,
    monthly_checkout_url: String,
    yearly_checkout_url: String,
    manage_url: String,
}

impl AccessConfig {
    #[cfg(target_os = "windows")]
    fn from_build() -> Option<Self> {
        Self::new(
            PRODUCT_ID?,
            MONTHLY_CHECKOUT_URL?,
            YEARLY_CHECKOUT_URL?,
            MANAGE_URL?,
        )
        .ok()
    }

    #[cfg(not(target_os = "windows"))]
    fn from_build() -> Option<Self> {
        None
    }

    fn new(
        product_id: &str,
        monthly_checkout_url: &str,
        yearly_checkout_url: &str,
        manage_url: &str,
    ) -> Result<Self, AccessFailure> {
        let product_id = product_id.trim();
        if product_id.is_empty()
            || product_id.len() > MAX_LICENSE_BYTES
            || !product_id.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(AccessFailure::NotConfigured);
        }
        let (monthly_checkout_url, monthly_product) =
            checked_checkout_url(monthly_checkout_url, "monthly")?;
        let (yearly_checkout_url, yearly_product) =
            checked_checkout_url(yearly_checkout_url, "yearly")?;
        if monthly_product != yearly_product {
            return Err(AccessFailure::NotConfigured);
        }
        Ok(Self {
            product_id: product_id.to_owned(),
            monthly_checkout_url,
            yearly_checkout_url,
            manage_url: checked_manage_url(manage_url)?,
        })
    }
}

fn checked_checkout_url(value: &str, recurrence: &str) -> Result<(String, String), AccessFailure> {
    let parsed = checked_gumroad_url(value)?;
    let segments = parsed
        .path_segments()
        .ok_or(AccessFailure::NotConfigured)?
        .collect::<Vec<_>>();
    if segments.len() != 2 || segments[0] != "l" || segments[1].is_empty() {
        return Err(AccessFailure::NotConfigured);
    }
    let mut recurrence_count = 0;
    let mut wanted_count = 0;
    for (key, value) in parsed.query_pairs() {
        if key == recurrence {
            if value != "true" {
                return Err(AccessFailure::NotConfigured);
            }
            recurrence_count += 1;
        } else if matches!(
            key.as_ref(),
            "monthly" | "quarterly" | "biannually" | "yearly"
        ) {
            return Err(AccessFailure::NotConfigured);
        }
        if key == "wanted" {
            if value != "true" {
                return Err(AccessFailure::NotConfigured);
            }
            wanted_count += 1;
        }
    }
    if recurrence_count != 1 || wanted_count != 1 {
        return Err(AccessFailure::NotConfigured);
    }
    let identity = format!(
        "{}{}",
        parsed.host_str().ok_or(AccessFailure::NotConfigured)?,
        parsed.path()
    );
    Ok((parsed.to_string(), identity))
}

fn checked_manage_url(value: &str) -> Result<String, AccessFailure> {
    let parsed = checked_gumroad_url(value)?;
    if parsed.path() != "/library"
        || !matches!(parsed.host_str(), Some("gumroad.com" | "app.gumroad.com"))
    {
        return Err(AccessFailure::NotConfigured);
    }
    Ok(parsed.to_string())
}

fn checked_gumroad_url(value: &str) -> Result<Url, AccessFailure> {
    if value.len() > 2_048 {
        return Err(AccessFailure::NotConfigured);
    }
    let parsed = Url::parse(value).map_err(|_| AccessFailure::NotConfigured)?;
    let host = parsed.host_str().ok_or(AccessFailure::NotConfigured)?;
    if parsed.scheme() != "https"
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.fragment().is_some()
        || !(host == "gumroad.com" || host.ends_with(".gumroad.com"))
    {
        return Err(AccessFailure::NotConfigured);
    }
    Ok(parsed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AccessFailure {
    NotConfigured,
    InvalidLicense,
    VerificationFailed,
    SecureStorageUnavailable,
    NoSavedLicense,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoreBotAccessStatus {
    pub full_access: bool,
    pub has_saved_key: bool,
    pub paid_controls_available: bool,
    pub monthly_checkout_url: Option<String>,
    pub yearly_checkout_url: Option<String>,
    pub manage_url: Option<String>,
}

fn status_for(
    config: Option<&AccessConfig>,
    full_access: bool,
    has_saved_key: bool,
) -> YoreBotAccessStatus {
    YoreBotAccessStatus {
        full_access,
        has_saved_key,
        paid_controls_available: config.is_some(),
        monthly_checkout_url: config.map(|value| value.monthly_checkout_url.clone()),
        yearly_checkout_url: config.map(|value| value.yearly_checkout_url.clone()),
        manage_url: config.map(|value| value.manage_url.clone()),
    }
}

async fn serialized_access<T>(
    coordinator: &tokio::sync::Mutex<()>,
    operation: impl Future<Output = T>,
) -> T {
    let _guard = coordinator.lock().await;
    operation.await
}

#[async_trait]
trait MembershipVerifier: Send + Sync {
    async fn verify(&self, config: &AccessConfig, license_key: &str) -> Result<(), AccessFailure>;
}

trait LicenseVault: Send + Sync {
    fn load(&self) -> Result<Option<String>, AccessFailure>;
    fn save(&self, license_key: &str) -> Result<(), AccessFailure>;
    fn delete(&self) -> Result<(), AccessFailure>;
}

struct GumroadVerifier {
    client: reqwest::Client,
}

impl GumroadVerifier {
    fn new() -> Result<Self, AccessFailure> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(VERIFY_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("YoreBot/2.0 access verification")
            .build()
            .map_err(|_| AccessFailure::VerificationFailed)?;
        Ok(Self { client })
    }
}

#[async_trait]
impl MembershipVerifier for GumroadVerifier {
    async fn verify(&self, config: &AccessConfig, license_key: &str) -> Result<(), AccessFailure> {
        let response = self
            .client
            .post(VERIFY_URL)
            .form(&[
                ("product_id", config.product_id.as_str()),
                ("license_key", license_key),
                ("increment_uses_count", "false"),
            ])
            .send()
            .await
            .map_err(|_| AccessFailure::VerificationFailed)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
        {
            return Err(AccessFailure::VerificationFailed);
        }

        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| AccessFailure::VerificationFailed)?;
            if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
                return Err(AccessFailure::VerificationFailed);
            }
            body.extend_from_slice(&chunk);
        }
        validate_provider_response(&body, &config.product_id)
    }
}

fn validate_provider_response(body: &[u8], product_id: &str) -> Result<(), AccessFailure> {
    let response: Value =
        serde_json::from_slice(body).map_err(|_| AccessFailure::VerificationFailed)?;
    let response = response
        .as_object()
        .ok_or(AccessFailure::VerificationFailed)?;
    if response.get("success") != Some(&Value::Bool(true)) {
        return Err(AccessFailure::InvalidLicense);
    }
    let purchase = response
        .get("purchase")
        .and_then(Value::as_object)
        .ok_or(AccessFailure::InvalidLicense)?;
    if purchase.get("product_id").and_then(Value::as_str) != Some(product_id)
        || !matches!(
            purchase.get("subscription_id").and_then(Value::as_str),
            Some(value) if !value.is_empty() && value.len() <= MAX_LICENSE_BYTES
        )
        || !matches!(
            purchase.get("recurrence").and_then(Value::as_str),
            Some("monthly" | "yearly")
        )
        || !is_explicit_false(purchase, "refunded")
        || !is_explicit_false(purchase, "disputed")
        || !is_explicit_false(purchase, "chargebacked")
        || !is_explicit_null(purchase, "subscription_ended_at")
        || !is_explicit_null(purchase, "subscription_cancelled_at")
        || !is_explicit_null(purchase, "subscription_failed_at")
    {
        return Err(AccessFailure::InvalidLicense);
    }
    Ok(())
}

fn is_explicit_false(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key) == Some(&Value::Bool(false))
}

fn is_explicit_null(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key) == Some(&Value::Null)
}

struct WindowsCredentialVault;

#[cfg(target_os = "windows")]
impl WindowsCredentialVault {
    fn entry() -> Result<keyring::Entry, AccessFailure> {
        keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
            .map_err(|_| AccessFailure::SecureStorageUnavailable)
    }
}

#[cfg(target_os = "windows")]
impl LicenseVault for WindowsCredentialVault {
    fn load(&self) -> Result<Option<String>, AccessFailure> {
        match Self::entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AccessFailure::SecureStorageUnavailable),
        }
    }

    fn save(&self, license_key: &str) -> Result<(), AccessFailure> {
        Self::entry()?
            .set_password(license_key)
            .map_err(|_| AccessFailure::SecureStorageUnavailable)
    }

    fn delete(&self) -> Result<(), AccessFailure> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AccessFailure::SecureStorageUnavailable),
        }
    }
}

#[cfg(not(target_os = "windows"))]
impl LicenseVault for WindowsCredentialVault {
    fn load(&self) -> Result<Option<String>, AccessFailure> {
        Err(AccessFailure::SecureStorageUnavailable)
    }

    fn save(&self, _license_key: &str) -> Result<(), AccessFailure> {
        Err(AccessFailure::SecureStorageUnavailable)
    }

    fn delete(&self) -> Result<(), AccessFailure> {
        Err(AccessFailure::SecureStorageUnavailable)
    }
}

fn normalized_license_key(value: &str) -> Result<String, AccessFailure> {
    let value = value.trim();
    if value.len() < 8
        || value.len() > MAX_LICENSE_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AccessFailure::InvalidLicense);
    }
    Ok(value.to_owned())
}

async fn current_status(
    entitlements: &SharedEntitlementStore,
    config: Option<&AccessConfig>,
    vault: &dyn LicenseVault,
) -> YoreBotAccessStatus {
    let full_access = entitlements.lock().await.has_verified_subscription();
    let has_saved_key = vault.load().ok().flatten().is_some();
    status_for(config, full_access, has_saved_key)
}

async fn restore_with(
    entitlements: &SharedEntitlementStore,
    config: Option<&AccessConfig>,
    verifier: &dyn MembershipVerifier,
    vault: &dyn LicenseVault,
    license_key: &str,
) -> Result<YoreBotAccessStatus, AccessFailure> {
    let config = config.ok_or(AccessFailure::NotConfigured)?;
    let license_key = normalized_license_key(license_key)?;
    verifier.verify(config, &license_key).await?;
    vault.save(&license_key)?;
    entitlements.lock().await.set_verified_subscription(true);
    Ok(status_for(Some(config), true, true))
}

async fn refresh_saved_with(
    entitlements: &SharedEntitlementStore,
    config: Option<&AccessConfig>,
    verifier: &dyn MembershipVerifier,
    vault: &dyn LicenseVault,
) -> Result<YoreBotAccessStatus, AccessFailure> {
    entitlements.lock().await.set_verified_subscription(false);
    let config = config.ok_or(AccessFailure::NotConfigured)?;
    let license_key = vault.load()?.ok_or(AccessFailure::NoSavedLicense)?;
    let license_key = normalized_license_key(&license_key)?;
    verifier.verify(config, &license_key).await?;
    entitlements.lock().await.set_verified_subscription(true);
    Ok(status_for(Some(config), true, true))
}

async fn forget_with(
    entitlements: &SharedEntitlementStore,
    config: Option<&AccessConfig>,
    vault: &dyn LicenseVault,
) -> Result<YoreBotAccessStatus, AccessFailure> {
    let mut entitlements = entitlements.lock().await;
    vault.delete()?;
    entitlements.set_verified_subscription(false);
    Ok(status_for(config, false, false))
}

fn public_restore_error(error: AccessFailure) -> String {
    match error {
        AccessFailure::NotConfigured => "Paid access is not available in this build.".into(),
        _ => "Access could not be restored. Check the key and connection.".into(),
    }
}

#[tauri::command]
pub async fn yorebot_access_status(
    state: State<'_, AppState>,
) -> Result<YoreBotAccessStatus, String> {
    let config = AccessConfig::from_build();
    Ok(serialized_access(
        &ACCESS_COMMANDS,
        current_status(
            &state.agent_entitlements,
            config.as_ref(),
            &WindowsCredentialVault,
        ),
    )
    .await)
}

#[tauri::command]
pub async fn yorebot_access_restore(
    license_key: String,
    state: State<'_, AppState>,
) -> Result<YoreBotAccessStatus, String> {
    let config = AccessConfig::from_build();
    let verifier = GumroadVerifier::new().map_err(public_restore_error)?;
    serialized_access(
        &ACCESS_COMMANDS,
        restore_with(
            &state.agent_entitlements,
            config.as_ref(),
            &verifier,
            &WindowsCredentialVault,
            &license_key,
        ),
    )
    .await
    .map_err(public_restore_error)
}

#[tauri::command]
pub async fn yorebot_access_refresh_saved(
    state: State<'_, AppState>,
) -> Result<YoreBotAccessStatus, String> {
    let config = AccessConfig::from_build();
    Ok(serialized_access(&ACCESS_COMMANDS, async {
        if let Ok(verifier) = GumroadVerifier::new() {
            let _ = refresh_saved_with(
                &state.agent_entitlements,
                config.as_ref(),
                &verifier,
                &WindowsCredentialVault,
            )
            .await;
        } else {
            state
                .agent_entitlements
                .lock()
                .await
                .set_verified_subscription(false);
        }
        current_status(
            &state.agent_entitlements,
            config.as_ref(),
            &WindowsCredentialVault,
        )
        .await
    })
    .await)
}

#[tauri::command]
pub async fn yorebot_access_forget(
    state: State<'_, AppState>,
) -> Result<YoreBotAccessStatus, String> {
    let config = AccessConfig::from_build();
    serialized_access(
        &ACCESS_COMMANDS,
        forget_with(
            &state.agent_entitlements,
            config.as_ref(),
            &WindowsCredentialVault,
        ),
    )
    .await
    .map_err(|_| "Saved access could not be forgotten.".into())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{Arc, Mutex as StdMutex},
    };

    use super::*;
    use crate::core::agent::entitlements::EntitlementStore;
    use tempfile::TempDir;
    use tokio::sync::Notify;

    fn config() -> AccessConfig {
        AccessConfig::new(
            "product-123",
            "https://yorebot.gumroad.com/l/access?monthly=true&wanted=true",
            "https://yorebot.gumroad.com/l/access?yearly=true&wanted=true",
            "https://gumroad.com/library",
        )
        .unwrap()
    }

    fn response(recurrence: &str) -> Value {
        serde_json::json!({
            "success": true,
            "uses": 1,
            "purchase": {
                "product_id": "product-123",
                "email": "private@example.com",
                "license_key": "SECRET-LICENSE-KEY",
                "subscription_id": "subscription-123",
                "recurrence": recurrence,
                "refunded": false,
                "disputed": false,
                "chargebacked": false,
                "subscription_ended_at": null,
                "subscription_cancelled_at": null,
                "subscription_failed_at": null
            }
        })
    }

    #[test]
    fn accepts_active_monthly_yearly_and_provider_trial_memberships() {
        for recurrence in ["monthly", "yearly"] {
            let body = serde_json::to_vec(&response(recurrence)).unwrap();
            assert_eq!(validate_provider_response(&body, "product-123"), Ok(()));
        }

        let mut trial = response("monthly");
        trial["purchase"]["price"] = Value::from(0);
        trial["purchase"]["is_free_trial"] = Value::Bool(true);
        assert_eq!(
            validate_provider_response(&serde_json::to_vec(&trial).unwrap(), "product-123"),
            Ok(())
        );
    }

    #[test]
    fn rejects_wrong_product_and_every_inactive_or_reversed_state() {
        let mut cases = Vec::new();

        let mut wrong_product = response("monthly");
        wrong_product["purchase"]["product_id"] = Value::String("other-product".into());
        cases.push(wrong_product);

        for field in ["refunded", "disputed", "chargebacked"] {
            let mut value = response("monthly");
            value["purchase"][field] = Value::Bool(true);
            cases.push(value);
        }
        for field in [
            "subscription_ended_at",
            "subscription_cancelled_at",
            "subscription_failed_at",
        ] {
            let mut value = response("monthly");
            value["purchase"][field] = Value::String("2026-08-29T00:00:00Z".into());
            cases.push(value);
        }
        let mut one_time = response("monthly");
        one_time["purchase"]["subscription_id"] = Value::Null;
        cases.push(one_time);
        cases.push(response("quarterly"));

        for value in cases {
            assert_eq!(
                validate_provider_response(&serde_json::to_vec(&value).unwrap(), "product-123"),
                Err(AccessFailure::InvalidLicense)
            );
        }
    }

    #[test]
    fn rejects_missing_safety_fields_instead_of_defaulting_them() {
        for field in [
            "refunded",
            "disputed",
            "chargebacked",
            "subscription_ended_at",
            "subscription_cancelled_at",
            "subscription_failed_at",
        ] {
            let mut value = response("monthly");
            value["purchase"].as_object_mut().unwrap().remove(field);
            assert_eq!(
                validate_provider_response(&serde_json::to_vec(&value).unwrap(), "product-123"),
                Err(AccessFailure::InvalidLicense)
            );
        }
    }

    #[test]
    fn configuration_is_https_gumroad_only_and_all_or_nothing() {
        assert!(AccessConfig::new(
            "product-123",
            "https://yorebot.gumroad.com/l/access?monthly=true&wanted=true",
            "https://yorebot.gumroad.com/l/access?yearly=true&wanted=true",
            "https://app.gumroad.com/library",
        )
        .is_ok());
        assert_eq!(
            AccessConfig::new(
                "product-123",
                "https://example.com/checkout",
                "https://gumroad.com/l/access?yearly=true&wanted=true",
                "https://gumroad.com/library",
            )
            .err(),
            Some(AccessFailure::NotConfigured)
        );
        assert_eq!(
            AccessConfig::new(
                "product-123",
                "http://gumroad.com/l/access",
                "https://gumroad.com/l/access?yearly=true&wanted=true",
                "https://gumroad.com/library",
            )
            .err(),
            Some(AccessFailure::NotConfigured)
        );
        assert_eq!(
            AccessConfig::new(
                "product-123",
                "https://gumroad.com/l/access?yearly=true&wanted=true",
                "https://gumroad.com/l/access?monthly=true&wanted=true",
                "https://gumroad.com/library",
            )
            .err(),
            Some(AccessFailure::NotConfigured)
        );
        for monthly_url in [
            "https://gumroad.com/l/access?monthly=true",
            "https://gumroad.com/l/access?monthly=false&wanted=true",
            "https://gumroad.com/l/access?monthly=true&wanted=false",
            "https://gumroad.com/l/access?monthly=true&yearly=true&wanted=true",
        ] {
            assert_eq!(
                AccessConfig::new(
                    "product-123",
                    monthly_url,
                    "https://gumroad.com/l/access?yearly=true&wanted=true",
                    "https://gumroad.com/library",
                )
                .err(),
                Some(AccessFailure::NotConfigured)
            );
        }

        for (monthly_url, yearly_url, manage_url) in [
            (
                "https://gumroad.com/?monthly=true&wanted=true",
                "https://gumroad.com/l/access?yearly=true&wanted=true",
                "https://gumroad.com/library",
            ),
            (
                "https://gumroad.com/l/?monthly=true&wanted=true",
                "https://gumroad.com/l/access?yearly=true&wanted=true",
                "https://gumroad.com/library",
            ),
            (
                "https://gumroad.com/l/monthly-product?monthly=true&wanted=true",
                "https://gumroad.com/l/yearly-product?yearly=true&wanted=true",
                "https://gumroad.com/library",
            ),
            (
                "https://creator-one.gumroad.com/l/access?monthly=true&wanted=true",
                "https://creator-two.gumroad.com/l/access?yearly=true&wanted=true",
                "https://gumroad.com/library",
            ),
            (
                "https://gumroad.com/l/access?monthly=true&wanted=true",
                "https://gumroad.com/l/access?yearly=true&wanted=true",
                "https://gumroad.com/l/access",
            ),
            (
                "https://gumroad.com/l/access?monthly=true&wanted=true",
                "https://gumroad.com/l/access?yearly=true&wanted=true",
                "https://creator.gumroad.com/library",
            ),
            (
                "https://gumroad.com:444/l/access?monthly=true&wanted=true",
                "https://gumroad.com:444/l/access?yearly=true&wanted=true",
                "https://gumroad.com/library",
            ),
            (
                "https://gumroad.com/l/access?monthly=true&wanted=true#monthly",
                "https://gumroad.com/l/access?yearly=true&wanted=true",
                "https://gumroad.com/library",
            ),
        ] {
            assert_eq!(
                AccessConfig::new("product-123", monthly_url, yearly_url, manage_url).err(),
                Some(AccessFailure::NotConfigured)
            );
        }
    }

    #[derive(Default)]
    struct FakeVault {
        value: StdMutex<Option<String>>,
        fail_save: bool,
        fail_delete: bool,
    }

    impl FakeVault {
        fn with(value: &str) -> Self {
            Self {
                value: StdMutex::new(Some(value.into())),
                fail_save: false,
                fail_delete: false,
            }
        }
    }

    impl LicenseVault for FakeVault {
        fn load(&self) -> Result<Option<String>, AccessFailure> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn save(&self, license_key: &str) -> Result<(), AccessFailure> {
            if self.fail_save {
                return Err(AccessFailure::SecureStorageUnavailable);
            }
            *self.value.lock().unwrap() = Some(license_key.into());
            Ok(())
        }

        fn delete(&self) -> Result<(), AccessFailure> {
            if self.fail_delete {
                return Err(AccessFailure::SecureStorageUnavailable);
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    struct FakeVerifier(Result<(), AccessFailure>);

    #[async_trait]
    impl MembershipVerifier for FakeVerifier {
        async fn verify(
            &self,
            _config: &AccessConfig,
            _license_key: &str,
        ) -> Result<(), AccessFailure> {
            self.0
        }
    }

    struct DelayedVerifier {
        started: Arc<Notify>,
        release: Arc<Notify>,
    }

    #[async_trait]
    impl MembershipVerifier for DelayedVerifier {
        async fn verify(
            &self,
            _config: &AccessConfig,
            _license_key: &str,
        ) -> Result<(), AccessFailure> {
            self.started.notify_one();
            self.release.notified().await;
            Ok(())
        }
    }

    fn entitlements() -> SharedEntitlementStore {
        std::sync::Arc::new(tokio::sync::Mutex::new(EntitlementStore::default()))
    }

    #[tokio::test]
    async fn successful_restore_saves_only_after_live_verification() {
        let entitlements = entitlements();
        let vault = FakeVault::default();
        let status = restore_with(
            &entitlements,
            Some(&config()),
            &FakeVerifier(Ok(())),
            &vault,
            "  VALID-LICENSE-123  ",
        )
        .await
        .unwrap();

        assert!(status.full_access);
        assert!(status.has_saved_key);
        assert_eq!(vault.load().unwrap().as_deref(), Some("VALID-LICENSE-123"));
        assert!(entitlements.lock().await.has_verified_subscription());
    }

    #[tokio::test]
    async fn restored_secret_never_enters_the_mutable_entitlement_file() {
        let temp = TempDir::new().unwrap();
        let entitlements = entitlements();
        let vault = FakeVault::default();
        restore_with(
            &entitlements,
            Some(&config()),
            &FakeVerifier(Ok(())),
            &vault,
            "SECRET-LICENSE-123",
        )
        .await
        .unwrap();
        entitlements
            .lock()
            .await
            .check_at(temp.path(), "model-a", chrono::Utc::now())
            .unwrap();

        let persisted = fs::read_to_string(temp.path().join("yorebot-entitlements.json")).unwrap();
        assert!(!persisted.contains("SECRET-LICENSE-123"));
        assert!(!persisted.contains("private@example.com"));
        assert_eq!(vault.load().unwrap().as_deref(), Some("SECRET-LICENSE-123"));
    }

    #[tokio::test]
    async fn failed_restore_preserves_prior_key_and_session_access() {
        let entitlements = entitlements();
        entitlements.lock().await.set_verified_subscription(true);
        let vault = FakeVault::with("OLD-LICENSE-123");

        assert_eq!(
            restore_with(
                &entitlements,
                Some(&config()),
                &FakeVerifier(Err(AccessFailure::InvalidLicense)),
                &vault,
                "NEW-LICENSE-123",
            )
            .await,
            Err(AccessFailure::InvalidLicense)
        );
        assert_eq!(vault.load().unwrap().as_deref(), Some("OLD-LICENSE-123"));
        assert!(entitlements.lock().await.has_verified_subscription());
    }

    #[tokio::test]
    async fn secure_storage_failure_neither_replaces_key_nor_grants_access() {
        let entitlements = entitlements();
        let vault = FakeVault {
            value: StdMutex::new(Some("OLD-LICENSE-123".into())),
            fail_save: true,
            fail_delete: false,
        };

        assert_eq!(
            restore_with(
                &entitlements,
                Some(&config()),
                &FakeVerifier(Ok(())),
                &vault,
                "NEW-LICENSE-123",
            )
            .await,
            Err(AccessFailure::SecureStorageUnavailable)
        );
        assert_eq!(vault.load().unwrap().as_deref(), Some("OLD-LICENSE-123"));
        assert!(!entitlements.lock().await.has_verified_subscription());
    }

    #[tokio::test]
    async fn saved_key_refresh_grants_only_this_process_and_network_error_falls_back_free() {
        let entitlements = entitlements();
        let vault = FakeVault::with("SAVED-LICENSE-123");
        let full = refresh_saved_with(
            &entitlements,
            Some(&config()),
            &FakeVerifier(Ok(())),
            &vault,
        )
        .await
        .unwrap();
        assert!(full.full_access);

        assert_eq!(
            refresh_saved_with(
                &entitlements,
                Some(&config()),
                &FakeVerifier(Err(AccessFailure::VerificationFailed)),
                &vault,
            )
            .await,
            Err(AccessFailure::VerificationFailed)
        );
        assert!(!entitlements.lock().await.has_verified_subscription());
        assert_eq!(vault.load().unwrap().as_deref(), Some("SAVED-LICENSE-123"));
    }

    #[tokio::test]
    async fn forget_clears_saved_and_process_access() {
        let entitlements = entitlements();
        entitlements.lock().await.set_verified_subscription(true);
        let vault = FakeVault::with("SAVED-LICENSE-123");

        let status = forget_with(&entitlements, Some(&config()), &vault)
            .await
            .unwrap();

        assert!(!status.full_access);
        assert!(!status.has_saved_key);
        assert_eq!(vault.load().unwrap(), None);
        assert!(!entitlements.lock().await.has_verified_subscription());
    }

    #[tokio::test]
    async fn failed_forget_preserves_saved_and_process_access() {
        let entitlements = entitlements();
        entitlements.lock().await.set_verified_subscription(true);
        let vault = FakeVault {
            value: StdMutex::new(Some("SAVED-LICENSE-123".into())),
            fail_save: false,
            fail_delete: true,
        };

        assert_eq!(
            forget_with(&entitlements, Some(&config()), &vault).await,
            Err(AccessFailure::SecureStorageUnavailable)
        );
        assert_eq!(vault.load().unwrap().as_deref(), Some("SAVED-LICENSE-123"));
        assert!(entitlements.lock().await.has_verified_subscription());
    }

    #[tokio::test]
    async fn forget_wins_over_an_older_delayed_startup_refresh() {
        let entitlements = entitlements();
        let vault = FakeVault::with("SAVED-LICENSE-123");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let verifier = DelayedVerifier {
            started: started.clone(),
            release: release.clone(),
        };
        let access_config = config();

        let coordinator = tokio::sync::Mutex::new(());
        let refresh = serialized_access(
            &coordinator,
            refresh_saved_with(&entitlements, Some(&access_config), &verifier, &vault),
        );
        let forget = async {
            started.notified().await;
            release.notify_one();
            serialized_access(
                &coordinator,
                forget_with(&entitlements, Some(&access_config), &vault),
            )
            .await
        };
        let (refresh, forget) = tokio::join!(refresh, forget);

        assert!(refresh.unwrap().full_access);
        assert!(!forget.unwrap().full_access);
        assert_eq!(vault.load().unwrap(), None);
        assert!(!entitlements.lock().await.has_verified_subscription());
    }

    #[tokio::test]
    async fn status_and_errors_never_return_provider_secrets() {
        let entitlements = entitlements();
        let vault = FakeVault::with("SECRET-LICENSE-KEY");
        let status = current_status(&entitlements, Some(&config()), &vault).await;
        let output = serde_json::to_string(&status).unwrap();

        assert!(!output.contains("SECRET-LICENSE-KEY"));
        assert!(!output.contains("private@example.com"));
        assert!(!public_restore_error(AccessFailure::InvalidLicense).contains("SECRET"));

        let rejected = serde_json::json!({
            "success": false,
            "message": "SECRET-LICENSE-KEY private@example.com"
        });
        assert_eq!(
            validate_provider_response(&serde_json::to_vec(&rejected).unwrap(), "product-123"),
            Err(AccessFailure::InvalidLicense)
        );
        let public = public_restore_error(AccessFailure::InvalidLicense);
        assert!(!public.contains("SECRET-LICENSE-KEY"));
        assert!(!public.contains("private@example.com"));
    }
}
