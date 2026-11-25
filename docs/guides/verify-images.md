# Verify a basefyio image and read its SBOM

Every application image of a production release (`basefyio-api`, `basefyio-ui`, `basefyio-website`)
is signed with [cosign](https://docs.sigstore.dev/cosign/overview/) after the deploy, and carries a
software bill of materials (SBOM, SPDX JSON) attached as a signed attestation. The signature is
keyless: it proves the image was signed by this repository's `sign-images.yml` workflow, with no
key for anyone to lose or steal.

Replace `<owner>` with the registry owner you pull from and `<sha>` with the image tag (the
12-character commit the image was built from, the same value as the deployed `IMAGE_TAG`).

## Verify the signature

```bash
cosign verify ghcr.io/<owner>/basefyio-api:<sha> \
  --certificate-identity-regexp '^https://github.com/talyaglobal/basefyio/\.github/workflows/sign-images\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A successful run prints the signature payload; a failure means the image was not signed by that
workflow and should not be deployed.

## Read the SBOM

```bash
cosign verify-attestation --type spdxjson ghcr.io/<owner>/basefyio-api:<sha> \
  --certificate-identity-regexp '^https://github.com/talyaglobal/basefyio/\.github/workflows/sign-images\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  | jq -r '.payload' | base64 -d | jq '.predicate' > sbom.spdx.json
```

`sbom.spdx.json` lists every package in the image. Each run of the workflow also keeps the SBOMs
as downloadable artifacts for 90 days.

## Notes

- Only images built by the production deploy are signed. Images tagged `latest` point at the newest
  signed build, but verify by the sha tag or by digest, which never moves.
- Signing runs after the deploy and never blocks it; if it fails, the release is live and only the
  `Sign images and publish SBOM` check is red.
- The base images (Postgres, Keycloak, Traefik, PgBouncer, MinIO) are third-party and are not
  re-signed here; pin them by digest as described in the self-hosting guide.
