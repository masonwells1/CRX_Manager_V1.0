## 2026-08-28 - Production migration retained-harness re-pin complete

The retained protected maintenance harness now accepts scanner blob
`e09a88ff0df5c235ccb05e0df0ac818b622639d0` and pins generated blob
`0e947bc2a86cda1bdb4b2ad860b3aef5e023e264`. Its 87 classifier assertions and 308 producer
assertions pass. The exact-head-reviewed one-use re-pin producer and its test were removed after the
transition, leaving no reusable alternate writer behind.
