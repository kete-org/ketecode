# CI-only test image for the kind e2e (kete-runner.yml): the runner built with -tags
# kete_testdriver (placeholder pod driver) and the fake platform. Never released.
FROM gcr.io/distroless/static-debian12:nonroot
COPY kete-job-host kete-fake-platform /usr/local/bin/
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/kete-job-host"]
