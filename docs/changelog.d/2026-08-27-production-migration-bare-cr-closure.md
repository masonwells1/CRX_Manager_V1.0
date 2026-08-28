## 2026-08-27 - Production migration bare-carriage-return closure

The production migration builder rejects any lone carriage return after normal CRLF-to-LF
normalization, and the top-level tokenizer treats carriage return or line feed as the end of a
PostgreSQL line comment. The exact-head-reviewed one-use maintenance producer applied the matching
protected destructive-scanner repair and was then removed. Permanent regression coverage reproduces
the reviewed bypass where a destructive statement followed a comment separated only by a carriage
return.
