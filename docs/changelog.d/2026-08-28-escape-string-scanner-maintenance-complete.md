## 2026-08-28 - Escape-string scanner maintenance complete

The exact-input and exact-output one-use producer received a dedicated read-only Sol/high review,
including 60 adversarial E-string and comment-marker mutations, before it wrote the protected
scanner. The old scanner was proven to allow the exploit through the hands-free decision path; the
same direct and end-to-end regressions pass against the reviewed output blob. The temporary producer
and its test are removed now that the permanent scanner fix and prevention checks are in place.
