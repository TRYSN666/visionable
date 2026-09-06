{{- define "network-topology.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "network-topology.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "network-topology.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "network-topology.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "network-topology.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "network-topology.selectorLabels" -}}
app.kubernetes.io/name: {{ include "network-topology.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
