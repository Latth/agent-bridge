# acme-mobile (Android)

- applicationId: `dev.acme.mobile` (staging flavor: `dev.acme.mobile.staging`)
- Staging build: `./gradlew installStagingDebug` (API https://api.staging.acme.dev)
- Network logging: OkHttp `HttpLoggingInterceptor` (logcat tag `OkHttp`), errors under tag `AuthRepository`.
- The logged-in user id is logged on startup: `I/Session: user=<id>`.
