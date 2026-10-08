{{- define "kete-runner.name" -}}kete-runner{{- end -}}

{{- define "kete-runner.labels" -}}
app.kubernetes.io/name: kete-runner
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: kete-code
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "kete-runner.selector" -}}
app.kubernetes.io/name: kete-runner
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The runner image, by digest only. */}}
{{- define "kete-runner.image" -}}
{{- $r := required "image.repository is required" .Values.image.repository -}}
{{- $d := required "image.digest is required (sha256:…)" .Values.image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $d) -}}{{- fail "image.digest must be sha256:<64 hex>" -}}{{- end -}}
{{- if contains "@" $r -}}{{- fail "image.repository must not carry a digest; set image.digest" -}}{{- end -}}
{{- printf "%s@%s" $r $d -}}
{{- end -}}

{{/* The controller's API identity, which the admission policy allows to create job pods. */}}
{{- define "kete-runner.username" -}}
{{- printf "system:serviceaccount:%s:%s" .Release.Namespace .Values.controller.serviceAccountName -}}
{{- end -}}

{{- define "kete-runner.checks" -}}
{{- if eq .Release.Namespace .Values.jobs.namespace -}}{{- fail "jobs.namespace must differ from the release namespace" -}}{{- end -}}
{{- if not (regexMatch "^https://[a-z0-9.-]+(:443)?/?$" (required "platform.url is required" .Values.platform.url)) -}}{{- fail "platform.url must be https://host" -}}{{- end -}}
{{- if or (lt (len .Values.jobs.images) 1) (gt (len .Values.jobs.images) 16) -}}{{- fail "jobs.images must list 1-16 job images by digest" -}}{{- end -}}
{{- range .Values.jobs.images -}}
{{- if not (regexMatch "^[a-z0-9.:-]+/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$" .) -}}{{- fail (printf "jobs.images entry %q is not <registry>/<repository>@sha256:<digest>" .) -}}{{- end -}}
{{- end -}}
{{- end -}}
