# User-guide screenshots

Drop screenshots/GIFs for [`docs/user-guide.md`](../../user-guide.md) here.

## Naming convention

`<app>-<screen>.png` (or `.gif`), lowercase, hyphenated. Used by the guide:

| File | What it should show |
|------|---------------------|
| `pro-place-order.png` | Pro: the limit-order form (price / size / recipient) |
| `pro-claim.png` | Pro: claiming matched proceeds |
| `pay-payout-wizard.png` | Pay: the new-payout wizard (token + recipients) — label as *preview* (mock data) |
| `operators-console.png` | Operators: the relayer dashboard (fills / fees / treasury) |
| `admin-console.png` | Admin: the governance console modules |

## How to add one

1. Capture the screen and save it here with the matching filename.
2. In `docs/user-guide.md`, replace the `> 📸 …` placeholder line with the image:
   ```markdown
   ![Pro — place a limit order](assets/user-guide/pro-place-order.png)
   ```
3. Keep images reasonably sized (≤ ~1600px wide, compressed) so the repo stays light.

GIFs are fine for short flows; keep them under a few MB. GitHub markdown can't embed
video — link out (Loom/YouTube) if you record a narrated walkthrough later.
