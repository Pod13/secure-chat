# TLS

The server speaks TLS 1.3 itself and has no plaintext mode. It refuses to start without `TLS_CERT_FILE` and `TLS_KEY_FILE` (PEM files, normally mounted from the secrets manager). Older TLS versions cannot be negotiated; `server/tests/tls.rs` proves it with real handshakes.

## Production

- Use a certificate from a public CA for the service's domain, with automatic renewal.
- Submit the domain to the HSTS preload list once the site is stable: the server already sends `max-age=63072000; includeSubDomains; preload`.
- Any load balancer in front must pass TLS through or re-encrypt with TLS 1.3 only.

## Local development

```sh
openssl req -x509 -newkey ed25519 -nodes -days 30 -subj /CN=localhost \
  -addext "subjectAltName=DNS:localhost" -keyout /tmp/dev-key.pem -out /tmp/dev-cert.pem
export TLS_CERT_FILE=/tmp/dev-cert.pem TLS_KEY_FILE=/tmp/dev-key.pem
export DATABASE_URL=postgres://postgres@localhost:55432/postgres
cargo run -p server
```

Never commit generated keys; `.gitignore` already excludes `*.pem` and `*.key`.
