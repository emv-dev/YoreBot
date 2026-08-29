# D6 — Permanent model-pack ownership and recovery

Status: decision packet only. No goal-tree change, entitlement, checkout, or
provider action is authorized by this document.

Supports: G4.2, S5, C6, D6

## Recommendation

Retire permanent model packs from the MVP. Keep free Chat, 2 million Agent
tokens per day, the 7-day trial, and the `$20/month` or `$200/year`
subscription unchanged.

If a permanent pack returns later, the minimum truthful design is a signed
portable license: a user-controlled token that the app verifies offline with
an embedded public key. Hosted restore can be a convenience, but cannot be the
authority. The token must have no expiry, device binding, or required online
revocation.

This separates two answers:

- Least MVP code: do not sell a permanent pack.
- Least design that can honestly promise permanent access: signed portable
  license, shipped only after its full recovery story works.

## What “permanent” can mean

It can mean that an issued model-pack license never expires and needs no later
payment or server permission. It cannot promise that future Windows versions,
hardware, model downloads, or installers will exist forever. A buyer must keep
the model, compatible app, and portable license backup.

The current `PermanentModelPack` enum and local set are dormant product seams,
not purchase proof. They have no issuer, signature, checkout, portable token,
or recovery path and therefore cannot support a public “forever” claim.

## Comparison

| Option | Reinstall | Different computer | Offline use | Abuse or resale | Company or server disappears | MVP cost |
|---|---|---|---|---|---|---|
| Hosted account restore | Works while the provider can find and verify the purchase | Same dependency; usually easy while the account/provider exists | A fresh install cannot restore offline; a cached local flag is not durable proof | Provider can reject disabled, refunded, disputed, or shared keys | Existing installs might keep a local grant, but lost installs cannot be restored truthfully | Lowest permanent-pack code, but fails D6 |
| Signed portable license | Import the backed-up token; no server call | Import the same token; no device transfer | Full offline verification | The signature prevents forgery, but a portable token can be copied or resold | Already-issued, backed-up tokens keep verifying; lost tokens cannot be reissued | Smallest truthful permanent design, but needs an issuer, key custody, format, import/export, and tests |
| Device-bound recovery | Works only if the bound device key survives; otherwise recovery is required | Requires transfer or reissue | Works only on the activated device | Best copying resistance | Activated devices can keep working; transfer and recovery stop with the service | Most code and support; contradicts portable recovery |
| Retire permanent packs from MVP | No permanent entitlement to restore | No permanent entitlement to transfer | Free local Chat remains; subscription-only Agent access keeps its existing verification fallback | No permanent token to police | Makes no forever promise; users retain whatever free local files and compatible app they already have | No new licensing system |

### Hosted account restore

This reuses the current Gumroad direction. Gumroad documents that buyers can
recover keys from receipts, purchase pages, its Library, or its lookup flow,
and that the app—not Gumroad—decides how a key is enforced. Its verification
API can report disabled, refunded, disputed, chargeback, and subscription
states ([license-key documentation](https://gumroad.com/help/article/76-license-keys),
[purchase recovery](https://gumroad.com/help/article/199-how-do-i-access-my-purchase)).

That is suitable for subscriptions. It is not independent “forever” proof:
clean-install recovery still depends on a reachable provider and retained
purchase records.

### Signed portable license

The issuer signs a bounded payload containing only a format version, random
license id, exact model-pack id, and issue date. The desktop app ships the
public key, verifies the signature locally, and imports or exports the token as
a file or recovery string. The private signing key never ships in the app.
Ed25519 supplies separate signing and verification keys with compact signatures
([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)).

The token is the authority. Account restore may return another copy while the
service exists, but offline use never depends on it. After shutdown there is no
device binding or revocation: a valid issued token continues to work. That also
means technical enforcement cannot stop copying, resale, or a later chargeback
without breaking the offline promise. A lost token is unrecoverable after the
issuer disappears, so checkout and the app must make backup explicit.

### Device-bound recovery

A device key can reduce copying. Windows can bind protected data to the same
user and machine, and a TPM can hold non-migratable keys
([DPAPI behavior](https://learn.microsoft.com/en-us/windows/win32/seccrypto/example-c-program-using-cryptprotectdata),
[TPM fundamentals](https://learn.microsoft.com/en-us/windows/security/hardware-security/tpm/tpm-fundamentals)).

The trade is recovery: new hardware, a cleared TPM, or some system resets need
a transfer service or human support. If that service disappears, the buyer
cannot exercise the promised device-change right. This is therefore a poor fit
for D6 even before its extra activation and support code.

### No permanent pack in the MVP

This matches the app's implemented commerce boundary: trial and subscription
verification exist as code seams; permanent purchase issuance and recovery do
not. The `$200/year` subscription remains `$200/year`. No one-time `$200`
offer ships.

This is the only weekend-sized choice that does not overpromise. A later issue
can validate demand before adding a signing service, private-key operations,
portable import/export, backup UX, and clean-install/offline acceptance tests.

## Re-entry gate for a future permanent pack

Do not expose checkout until all of these pass on clean Windows installations:

1. A real purchase returns one signed token for one exact model pack.
2. The token contains no email, payment data, device id, signing secret, or
   expiry; the portable token itself is treated as a bearer entitlement.
3. Reinstall and a different computer accept the backed-up token offline.
4. Tampered, wrong-model, malformed, and unsigned tokens fail closed.
5. Losing the issuer network does not affect an already-issued token.
6. Product copy states that backup is the buyer's shutdown recovery and that
   compatible software, hardware, and model files are separate requirements.

## Exact proposed `GOAL_TREE.md` edits — not applied

These edits require Enrique's explicit approval.

1. In the outcome diagram and heading, replace `G4 Use free chat, trial,
   permanent, or catalog access` with `G4 Use free chat, trial, or catalog
   access`. Keep G4.2 visible and label it `G4.2 Permanent model pack (retired
   from MVP)`; do not recycle the id.

2. Replace the G4.2 row with:

   ```text
   | G4.2 | capability | retired | Permanent model-pack sale is out of the MVP | No permanent-purchase CTA, checkout, or marketing promise ships; reconsider only after a separately approved signed portable-license design proves offline use, reinstall, device change, and shutdown behavior | human decision, <approval date> |
   ```

3. Replace S5 with:

   ```text
   | S5 | strategy | committed | Reuse hosted checkout for the seven-day full-tier trial and `$20/month` or `$200/year` subscription catalog access; do not sell permanent model packs in the MVP | Provider-backed tests cover trial start, cancellation, expiry, subscription restore and cancellation, and free fallback; no permanent-purchase surface exists |
   ```

4. Replace C6 with:

   ```text
   | C6 | constraint | committed | No lifetime catalog or permanent model-pack promise ships in the MVP; `$200` remains the yearly subscription price | Every paid CTA is a monthly or yearly subscription; no lifetime, forever, or one-time model-pack offer appears |
   ```

5. Remove D6 from **Open decisions** and add this row to **Resolved
   decisions**:

   ```text
   | D6 | decision | committed | Retire permanent model packs from the MVP. A future permanent pack may return only after a separately approved signed portable license can be backed up, imported, and verified offline without device binding or recurring server permission; hosted-only and device-bound recovery cannot be marketed as forever. |
   ```

6. Replace the G4.2 evidence-ledger row with:

   ```text
   | G4.2, D6 | human decision | Permanent model-pack sale retired from the MVP; no permanent entitlement or checkout is part of the launch gate | <approval date> |
   ```

7. Replace weekend acceptance item 6 with:

   ```text
   6. Complete a real monthly or yearly subscription checkout, restore it on a clean installation, confirm Full access after live verification, then restart offline and confirm free Chat remains available while Agent access falls back to 2,000,000 tokens per day.
   ```

### Proposed change notice

```text
Authorization: not granted; this packet is a proposal for Enrique
Added: none
Changed: G4 label only; S5; C6; D6 resolution; weekend acceptance item 6
Retired: G4.2 — permanent model-pack sale removed from the MVP
Evidence/status only: G4.2 and D6 after approval
Unchanged boundaries: G4.1, G4.3, G4.4, D4, free Chat, 2M Agent tokens/day, 7-day trial, $20/month, $200/year, model provenance, Windows-first scope
```

Sources checked: 2026-08-29. External links above are primary Gumroad,
Microsoft, and RFC Editor documentation.
