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

{{/* The admission policies' names (each binding has its policy's name); also config admission_policies. */}}
{{- define "kete-runner.policyNames" -}}
{{- $base := printf "kete-runner-%s" .Values.jobs.namespace -}}
{{- dict "pods" (printf "%s-pods" $base) "jobSecrets" (printf "%s-secrets" $base) "outboxes" (printf "%s-outboxes" $base) "controllerSecrets" (printf "kete-runner-%s-controller" .Release.Namespace) | toJson -}}
{{- end -}}

{{- define "kete-runner.checks" -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" .Values.controller.serviceAccountName) -}}{{- fail "controller.serviceAccountName must be a DNS-1123 label" -}}{{- end -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" .Release.Name) -}}{{- fail "the release name must be a DNS-1123 label" -}}{{- end -}}
{{- range .Values.jobs.egress.cidrs -}}
{{- $parts := splitList "/" . -}}
{{- if or (ne (len $parts) 2) (lt (atoi (index $parts 1)) 8) (hasPrefix "169.254." .) (hasPrefix "169.0.0.0/" .) -}}{{- fail (printf "jobs.egress.cidrs entry %q: name the proxy and endpoints narrowly (prefix /8 or longer, never 0.0.0.0/0, ::/0 or the link-local metadata range)" .) -}}{{- end -}}
{{- end -}}
{{- if eq .Release.Namespace .Values.jobs.namespace -}}{{- fail "jobs.namespace must differ from the release namespace" -}}{{- end -}}
{{- if not (regexMatch "^https://[a-z0-9.-]+(:443)?/?$" (required "platform.url is required" .Values.platform.url)) -}}{{- fail "platform.url must be https://host" -}}{{- end -}}
{{- if or (lt (len .Values.jobs.images) 1) (gt (len .Values.jobs.images) 16) -}}{{- fail "jobs.images must list 1-16 job images by digest" -}}{{- end -}}
{{- range .Values.jobs.images -}}
{{- if not (regexMatch "^[a-z0-9.:-]+/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$" .) -}}{{- fail (printf "jobs.images entry %q is not <registry>/<repository>@sha256:<digest>" .) -}}{{- end -}}
{{- end -}}
{{- if eq .Values.podDriver "kubevm" -}}
{{- $names := list -}}
{{- range .Values.repositorySources -}}
{{- if not (has .name $.Values.repositories) -}}{{- fail (printf "repositorySources entry %q names no repository in repositories" .name) -}}{{- end -}}
{{- $names = append $names .name -}}
{{- end -}}
{{- range .Values.repositories -}}
{{- if not (has . $names) -}}{{- fail (printf "repository %q has no repositorySources entry (podDriver kubevm clones only from a configured source)" .) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if eq .Values.podDriver "kubevm" -}}
{{- if not .Values.jobs.outbox.storageClass -}}{{- fail "jobs.outbox.storageClass is required: a StorageClass that enforces capacity and mounts nosuid,nodev,noexec (README \"Outbox storage\")" -}}{{- end -}}
{{- if and .Values.jobs.proxy.authSecret.name (not .Values.proxy.url) -}}{{- fail "jobs.proxy.authSecret needs proxy.url" -}}{{- end -}}
{{- if and .Values.jobs.proxy.authSecret.name (eq .Values.jobs.proxy.authSecret.name .Values.proxy.authSecret.name) (eq .Values.jobs.proxy.authSecret.key .Values.proxy.authSecret.key) -}}{{- fail "jobs.proxy.authSecret must be a credential distinct from proxy.authSecret" -}}{{- end -}}
{{- end -}}
{{- if and .Values.proxy.authSecret.name (not .Values.proxy.url) -}}{{- fail "proxy.authSecret needs proxy.url" -}}{{- end -}}
{{- end -}}
