# Windows signed-candidate setup

YoreBot uses Azure Artifact Signing with the existing Tauri/NSIS package. It
does not create an MSIX package. The workflow produces an ephemeral candidate
for verification; it is not a public release and does not publish to GitHub
Releases or enable the updater.

## Human setup

1. Complete Azure Artifact Signing identity validation, create a signing
   account and certificate profile, and accept the current Azure cost and
   billing terms. The workflow does not create or purchase Azure resources.
2. Create a Microsoft Entra application/service principal and give it only the
   `Artifact Signing Certificate Profile Signer` role for the selected profile.
3. Add a federated GitHub Actions credential:

   - issuer: `https://token.actions.githubusercontent.com`
   - audience: `api://AzureADTokenExchange`
   - subject: `repo:emv-dev/YoreBot:environment:windows-production-signing`

4. Create the GitHub environment `windows-production-signing`. Require a human
   reviewer and restrict deployment branches as appropriate. Add these Actions
   variables to that environment:

   - `AZURE_CLIENT_ID`
   - `AZURE_TENANT_ID`
   - `AZURE_SUBSCRIPTION_ID`
   - `AZURE_ARTIFACT_SIGNING_ENDPOINT`
   - `AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME`
   - `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME`
   - `YOREBOT_WINDOWS_SIGNER_SUBJECT` — the exact Authenticode certificate
     subject expected from `Get-AuthenticodeSignature`.

Authentication is OIDC federation only. Do not add long-lived Azure credential
secrets to the repository or environment.

## Run and evidence

Manually dispatch `YoreBot Windows signed candidate` and enter
`SIGN_YOREBOT_WINDOWS_CANDIDATE`. The workflow fails before checkout when the
confirmation or any required variable is absent.

It builds the release app without bundling, signs the main YoreBot executable,
bundles NSIS, signs the installer, and then requires:

- valid Authenticode status, the exact configured signer subject, and a trusted
  timestamp on the installer and installed main app;
- a fresh isolated install, eight-second process liveness, exact bundled
  `b10431/win-cpu-x64` readiness, safe uninstall, and sibling-file/process
  survival.

Only the main app executable and NSIS installer are claimed as signed. Bundled
helpers such as `jan-cli.exe`, `bun`, `uv`, `llama-server.exe`, and its DLLs are
not covered by this story. YoreBot is a public repository, so an Actions
artifact would be available to signed-in users with repository read access.
The workflow therefore does not upload the candidate; the hosted runner
discards it after verification. A valid signature also does not prove
immediate SmartScreen reputation or authorize a public launch.

The Azure actions are pinned to the reviewed `v3` and `v2` commits. Setup
references: [Artifact Signing OIDC](https://github.com/Azure/artifact-signing-action/blob/c7ab2a863ab5f9a846ddb8265964877ef296ee82/docs/OIDC.md),
[Microsoft Entra workload federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust),
[Azure Artifact Signing pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/),
and [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).
