## 2026-09-05 - Pin document-date writer access during Chicago-date replacement

- Harden `20260905020500_document_dates_follow_chicago_business_day.sql` so its four `SECURITY DEFINER` replacements refuse drifted execution grants before changing anything.
- Reassert and postflight the exact reviewed principal sets, preventing a preserved `PUBLIC`, `anon`, or unauthorized `authenticated` grant from bypassing the public wrappers.
- Extend the disposable PostgreSQL proof with both preflight and postflight ACL mutations; each must abort atomically and leave the reviewed function bodies and grants unchanged.
- This candidate remains parked and unapplied. The change does not query or mutate production.
