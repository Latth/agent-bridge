package dev.acme.mobile.net

import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor

object ApiClient {
    val http: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(RequestIdInterceptor())          // adds X-Request-Id
        .addInterceptor(AuthInterceptor())               // adds Authorization: Bearer <token>
        .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.HEADERS })
        .build()
}
