## 2026-09-08 - Keep private delivery signatures on their own route

- Clear the previous delivery's signed signature URL before a reused Delivery Detail component paints a newly selected delivery.
- Refuse delayed signed-URL responses after the operator has navigated to a different delivery, preventing delivery A's signature from appearing on delivery B.
- Add real-component regressions for both the visible stale-URL window and the late-response race; each guard was separately removed and observed failing before restoration.
