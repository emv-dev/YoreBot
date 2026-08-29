# Gumroad access setup

Status: code-ready only. No product, account, checkout, charge, or customer has
been created or tested.

YoreBot uses one Gumroad membership product and the public license verification
API. Configure the product manually with license keys, a 7-day trial, a
`$20/month` option, and a `$200/year` option. Gumroad owns checkout, the first
charge date, cancellation, taxes, receipts, and card data.

Set these public values when compiling the desktop app:

```text
YOREBOT_GUMROAD_PRODUCT_ID
YOREBOT_GUMROAD_MONTHLY_CHECKOUT_URL
YOREBOT_GUMROAD_YEARLY_CHECKOUT_URL
YOREBOT_GUMROAD_MANAGE_URL
```

All four are required. URLs must be HTTPS Gumroad URLs. The monthly checkout
must contain `monthly=true&wanted=true`; the yearly checkout must contain
`yearly=true&wanted=true`. These are Gumroad's official direct-checkout plan
selectors ([reference](https://gumroad.com/help/article/270-url-parameters)).
The values are public build configuration, not secrets. YoreBot has no Gumroad
API token.

Restore sends only the configured product id and entered license key to
Gumroad's license verification endpoint with usage counting disabled. YoreBot
accepts only that product, monthly or yearly recurrence, an active subscription,
and explicit non-refund/non-dispute/non-chargeback state. Gumroad's cancellation,
failure, and end timestamps represent the membership end date; access continues
only while all three remain null.

On Windows, a successfully verified key is saved in Credential Manager under
service `YoreBot` and account `subscription-license`. The mutable entitlement
JSON stores only daily Agent usage and the currently inert permanent-pack list.
It cannot grant trial or subscription access. Every process must verify the
saved key live before full Agent access is enabled; missing configuration,
secure-storage failure, invalid status, or network failure leaves Free access.

Before any public launch, a human must verify the hosted page shows the exact
trial length, prices, first charge date, cancellation path, and license key.
That live provider/account/payment evidence is intentionally outside this PR.
