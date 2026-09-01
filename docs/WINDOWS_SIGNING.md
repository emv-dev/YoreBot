# Windows signed-draft setup

YoreBot uses Azure Artifact Signing with the existing Tauri/NSIS package. It
does not create an MSIX package. The manual workflow verifies one signed
candidate, then stages it as an unpublished GitHub draft. It never publishes a
release, changes the public site, or enables the updater.

## Human setup

1. Complete Azure Artifact Signing identity validation, create a signing
   account and certificate profile, and accept the current Azure cost and
   billing terms. The workflow does not create or purchase Azure resources.
2. Create a Microsoft Entra application/service principal and give it only the
   `Artifact Signing Certificate Profile Signer` role for the selected profile.
3. Add a federated GitHub Actions credential:

   - issuer: `https://token.actions.githubusercontent.com`
   - audience: `api://AzureADTokenExchange`
   - subject: `repo:emv-dev@4650476/YoreBot@1350153489:environment:windows-production-signing`

   Re-read the immutable owner and repository IDs before creating the
   credential:

   ```bash
   gh api repos/emv-dev/YoreBot --jq '"repo:\(.owner.login)@\(.owner.id)/\(.name)@\(.id):environment:windows-production-signing"'
   ```

4. Create the GitHub environment `windows-production-signing`. Require a human
   reviewer and **restrict deployment branches to `yorebot-v2-base` only**.
   The workflow also rejects every other `github.ref` before checkout. Add
   these Actions variables to that environment:

   - `AZURE_CLIENT_ID`
   - `AZURE_TENANT_ID`
   - `AZURE_SUBSCRIPTION_ID`
   - `AZURE_ARTIFACT_SIGNING_ENDPOINT`
   - `AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME`
   - `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME`
   - `YOREBOT_WINDOWS_SIGNER_SUBJECT` — the exact Authenticode certificate
     subject expected from `Get-AuthenticodeSignature`.
   - `YOREBOT_GUMROAD_PRODUCT_ID`
   - `YOREBOT_GUMROAD_MONTHLY_CHECKOUT_URL`
   - `YOREBOT_GUMROAD_YEARLY_CHECKOUT_URL`
   - `YOREBOT_GUMROAD_MANAGE_URL`

   The Gumroad values are public build configuration, not credentials. They
   must satisfy the exact one-product contract in
   [`GUMROAD_ACCESS.md`](GUMROAD_ACCESS.md); the workflow validates them and
   proves the built app contains each exact value before signing.

Authentication is OIDC federation only. Do not add long-lived Azure credential
secrets to the repository or environment.

## Run and evidence

Manually dispatch `YoreBot Windows signed draft release`, enter
`SIGN_AND_DRAFT_YOREBOT_WINDOWS_RELEASE`, and supply the exact app-version tag
`yorebot-v2.0.0`. The repository inherited upstream `v2.0.0` through
`v2.0.25` tags, so the workflow rejects generic `v*` tags and accepts only
`yorebot-v${tauri version}`. It also refuses any existing tag or release. The
workflow fails before build when confirmation, branch, tag, or any required
variable is absent or invalid.

It builds the release app without bundling, signs the main YoreBot executable,
bundles NSIS, signs the installer, and then requires:

- valid Authenticode status, the exact configured signer subject, and a trusted
  timestamp on the installer and installed main app;
- a fresh isolated install, eight-second process liveness, exact bundled
  `b10431/win-cpu-x64` readiness, safe uninstall, and sibling-file/process
  survival.

Only after those gates pass, the final step creates the exact lightweight tag
at the workflow commit and one unpublished draft containing exactly:

- `YoreBot_2.0.0_x64-setup.exe`;
- `YoreBot_2.0.0_x64-setup.exe.sha256`.

It verifies draft state, the exact lightweight tag ref's commit SHA, asset
names, sizes, server-reported SHA-256 digests, and each exact
`https://github.com/emv-dev/YoreBot/releases/download/...` URL. The draft title
and description are publication-ready; a hidden run marker exists only to
prove rollback ownership. If staging fails, cleanup re-reads that exact marker,
target commit, release id, and tag target before deleting anything. The tag is
considered run-owned only after its explicit create-ref call returns the exact
HTTP 201/ref/SHA response; a lost or ambiguous response is retained for human
inspection, never deleted. Cleanup never deletes pre-existing or ambiguous
state.

Only the main app executable and NSIS installer are claimed as signed. Bundled
helpers such as `jan-cli.exe`, `bun`, `uv`, `llama-server.exe`, and its DLLs are
not covered by this story. YoreBot is a public repository, so an Actions
artifact would be available to signed-in users with repository read access.
The workflow therefore does not upload an Actions artifact. The job carries
`contents: write` throughout because the verified installer cannot safely cross
jobs here. Every action is pinned, checkout credentials are not persisted, and
only the final shell step receives `GH_TOKEN` in its environment. Publishing
the verified draft remains a separate human action. A valid signature also does
not prove immediate SmartScreen reputation or authorize a public launch.

The Azure actions are pinned to the reviewed `v3` and `v2` commits. Setup
references: [Artifact Signing OIDC](https://github.com/Azure/artifact-signing-action/blob/c7ab2a863ab5f9a846ddb8265964877ef296ee82/docs/OIDC.md),
[Microsoft Entra workload federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust),
[Azure Artifact Signing pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/),
and [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).
