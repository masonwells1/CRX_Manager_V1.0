## 2026-08-28 - Production migration retained-harness output re-pin

The reviewed scanner-input re-pin changed the retained maintenance harness's deterministically
generated blob from `7bca8dce4fe2f58afabdbd09d1b31ecef61ce520` to
`0e947bc2a86cda1bdb4b2ad860b3aef5e023e264`. A second one-use transition pins that exact generated
blob. The fail-closed transition completed only after a fresh exact-head Sol/high clean review, and
the temporary producer was removed after the retained harness and its focused tests passed.
