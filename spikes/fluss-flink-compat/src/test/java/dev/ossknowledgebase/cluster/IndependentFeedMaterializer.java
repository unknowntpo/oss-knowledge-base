package dev.ossknowledgebase.cluster;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Collator;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

final class IndependentFeedMaterializer {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private IndependentFeedMaterializer() {}

    static ObjectNode materialize(JsonNode fixture, List<JsonNode> currentEvents) throws Exception {
        JsonNode config = fixture.required("config");
        Map<String, JsonNode> profiles = new HashMap<>();
        for (JsonNode profile : config.required("projectProfiles")) {
            profiles.put(profile.required("projectId").asText(), profile);
        }

        Map<String, JsonNode> byEntity = new HashMap<>();
        for (JsonNode event : currentEvents) {
            String entityId = event.required("entityId").asText();
            if (byEntity.put(entityId, event) != null) {
                throw new IllegalArgumentException("Duplicate current entity " + entityId);
            }
        }

        List<JsonNode> roots = currentEvents.stream()
                .filter(event -> !event.required("data").required("recordKind").asText().equals("comment"))
                .sorted(Comparator.comparing(event -> event.required("entityId").asText()))
                .toList();
        ArrayNode entries = MAPPER.createArrayNode();
        ArrayNode details = MAPPER.createArrayNode();

        for (JsonNode root : roots) {
            String rootId = root.required("entityId").asText();
            JsonNode profile = profiles.get(root.required("projectId").asText());
            if (profile == null) throw new IllegalArgumentException("Missing profile for " + rootId);
            List<JsonNode> groupEvents = currentEvents.stream()
                    .filter(event -> event.required("entityId").asText().equals(rootId)
                            || event.required("data").path("parentEntityId").asText().equals(rootId))
                    .sorted(Comparator.comparing(event -> event.required("entityId").asText()))
                    .toList();

            ArrayNode recordIds = strings(groupEvents.stream().map(event -> event.required("entityId").asText()).toList());
            List<String> evidenceIds = groupEvents.stream()
                    .filter(event -> !event.required("data").required("isBot").asBoolean())
                    .map(event -> event.required("id").asText())
                    .sorted()
                    .toList();
            ArrayNode connectionIds = MAPPER.createArrayNode();
            ArrayNode connections = MAPPER.createArrayNode();
            for (JsonNode event : groupEvents) {
                String entityId = event.required("entityId").asText();
                if (entityId.equals(rootId)) continue;
                String connectionId = "connection:" + entityId + ":discusses:" + rootId;
                connectionIds.add(connectionId);
                connections.add(object(
                        "id", connectionId,
                        "fromRecordId", entityId,
                        "toRecordId", rootId,
                        "kind", "discusses",
                        "derivation", object("kind", "deterministic-rule", "revision", config.required("clusteringRevision").asText())));
            }

            ObjectNode entry = object(
                    "id", "feed-entry:feed-record-group:" + rootId,
                    "projectId", root.required("projectId").asText(),
                    "title", root.required("data").required("title").asText(),
                    "summary", root.required("data").required("excerpt").asText(),
                    "sourceTitleRecordId", rootId,
                    "recordIds", recordIds,
                    "highlightedRecordIds", strings(List.of(rootId)),
                    "reason", object(
                            "kind", "trending",
                            "label", evidenceIds.size() + " GitHub activity signals in the last "
                                    + config.required("activityWindowDays").asInt() + " days",
                            "evidenceEventIds", strings(evidenceIds)),
                    "activity", object("score", evidenceIds.size(), "evidenceEventIds", strings(evidenceIds)),
                    "grouping", object(
                            "relationshipIds", connectionIds,
                            "clusteringRevision", config.required("clusteringRevision").asText()));

            ArrayNode records = MAPPER.createArrayNode();
            for (JsonNode event : groupEvents) records.add(sourceRecord(event, rootId));
            ArrayNode keyPoints = MAPPER.createArrayNode();
            keyPoints.add(object(
                    "id", "key-point:" + rootId + ":scope",
                    "text", root.required("data").required("excerpt").asText(),
                    "evidenceRecordIds", strings(List.of(rootId))));
            groupEvents.stream()
                    .filter(event -> event.required("data").required("recordKind").asText().equals("comment"))
                    .filter(event -> !event.required("data").required("isBot").asBoolean())
                    .filter(event -> event.required("data").required("excerpt").asText().length() >= 80)
                    .sorted(Comparator
                            .comparing((JsonNode event) -> event.required("data").required("occurredAt").asText()).reversed()
                            .thenComparing(event -> event.required("entityId").asText()))
                    .findFirst()
                    .ifPresent(reply -> keyPoints.add(object(
                            "id", "key-point:" + reply.required("entityId").asText() + ":latest",
                            "text", "Latest community update from " + reply.required("data").required("author").asText()
                                    + ": " + reply.required("data").required("excerpt").asText(),
                            "evidenceRecordIds", strings(List.of(reply.required("entityId").asText())))));

            String kind = root.required("data").required("recordKind").asText();
            // Spec 012 / ADR-0014: a detail carries its entry's display id.
            String displayId = profile.required("projectKey").asText().toUpperCase() + "-"
                    + (kind.equals("issue") ? "ISSUE" : "PR") + "-" + root.required("data").required("externalNumber").asInt();
            details.add(object(
                    "displayId", displayId,
                    "entry", entry.deepCopy(),
                    "records", records,
                    "connections", connections,
                    "keyPoints", object(
                            "status", "generated",
                            "points", keyPoints,
                            "derivation", object("kind", "source-extract", "revision", config.required("keyPointRevision").asText()))));

            Set<String> authors = new TreeSet<>();
            for (JsonNode event : groupEvents) {
                if (!event.required("data").required("isBot").asBoolean()) {
                    authors.add(event.required("data").required("author").asText());
                }
            }
            List<String> searchParts = new ArrayList<>();
            searchParts.add(entry.required("title").asText());
            searchParts.add(entry.required("summary").asText());
            searchParts.addAll(authors);
            for (JsonNode event : groupEvents) {
                JsonNode record = sourceRecord(event, rootId);
                searchParts.add(record.required("title").asText());
                searchParts.add(record.required("excerpt").asText());
                searchParts.add(record.required("author").asText());
            }
            List<String> tags = new ArrayList<>();
            tags.add(kind.equals("issue") ? "Issue" : "Pull Request");
            root.required("data").required("labels").forEach(label -> tags.add(label.asText()));
            tags.subList(1, tags.size()).sort(String::compareTo);
            String lastActivityAt = groupEvents.stream()
                    .map(event -> event.required("data").required("occurredAt").asText())
                    .max(String::compareTo)
                    .orElseThrow();

            entries.add(object(
                    "displayId", displayId,
                    "projectKey", profile.required("projectKey").asText(),
                    "status", status(root),
                    "releaseLabel", "GitHub " + (kind.equals("issue") ? "Issue" : "Pull Request") + " #"
                            + root.required("data").required("externalNumber").asInt(),
                    "authors", strings(new ArrayList<>(authors)),
                    "tags", strings(tags),
                    "links", object("github", root.required("canonicalUrl").asText()),
                    "sourceCounts", object("github", groupEvents.size()),
                    "lastActivityAt", lastActivityAt,
                    "searchText", String.join(" ", searchParts),
                    "entry", entry));
        }

        List<JsonNode> sortedProfiles = new ArrayList<>();
        fixture.required("config").required("projectProfiles").forEach(sortedProfiles::add);
        sortedProfiles.sort(Comparator.comparing(profile -> profile.required("projectKey").asText()));
        ArrayNode projects = MAPPER.createArrayNode();
        for (JsonNode profile : sortedProfiles) {
            projects.add(object(
                    "key", profile.required("projectKey").asText(),
                    "label", profile.required("label").asText(),
                    "profileVersion", profile.required("profileVersion").asText(),
                    "statusPolicyRef", profile.required("statusPolicyRef").asText(),
                    "statusFacetKey", "filter.status.github",
                    "sources", strings(List.of("github")),
                    "statuses", array(
                            object("key", "open", "label", "Open"),
                            object("key", "merged", "label", "Merged"),
                            object("key", "closed", "label", "Closed"))));
        }
        ObjectNode profileRevisions = MAPPER.createObjectNode();
        for (JsonNode profile : config.required("projectProfiles")) {
            profileRevisions.put(profile.required("projectId").asText(), profile.required("profileVersion").asText());
        }
        ObjectNode publication = object(
                "index", object(
                        "schema", "osskb.feed-index.v2",
                        "generatedAt", config.required("materializedAt").asText(),
                        "sourceTypes", object("github", object(
                                "key", "github", "label", "GitHub", "full", "GitHub issues, pull requests, and comments")),
                        "projects", projects,
                        "entries", entries,
                        "metadata", object(
                                "mode", "replayable-reference-pipeline",
                                "materializedAt", config.required("materializedAt").asText(),
                                "inputEventCount", currentEvents.size(),
                                "rejectedEventCount", 0,
                                "materializerRevision", config.required("materializerRevision").asText(),
                                "clusteringRevision", config.required("clusteringRevision").asText(),
                                "profileRevisions", profileRevisions)),
                "details", details);
        String digest = "sha256:" + sha256(canonicalJson(publication));
        return object("schema", "osskb.reference-projection.v1", "digest", digest, "publication", publication);
    }

    private static ObjectNode sourceRecord(JsonNode event, String rootId) {
        JsonNode data = event.required("data");
        String kind = data.required("recordKind").asText();
        String title = kind.equals("comment")
                ? "Comment on #" + data.required("externalNumber").asInt()
                : (kind.equals("issue") ? "Issue" : "PR") + " #" + data.required("externalNumber").asInt()
                        + ": " + data.required("title").asText();
        ObjectNode record = object(
                "id", event.required("entityId").asText(),
                "projectId", event.required("projectId").asText(),
                "sourceInstanceId", event.required("sourceInstanceId").asText(),
                "source", "github",
                "sourceType", "code-host",
                "kind", kind.equals("issue") ? "GitHub Issue" : kind.equals("pull-request") ? "Pull Request" : "Comment",
                "title", title,
                "excerpt", data.required("excerpt").asText(),
                "author", data.required("author").asText(),
                "role", data.required("authorRole").asText(),
                "occurredAt", data.required("occurredAt").asText(),
                "canonicalUrl", event.required("canonicalUrl").asText(),
                "sourceVersion", event.required("sourceCursor").asText());
        if (event.required("entityId").asText().equals(rootId)) record.put("artifactStatus", status(event));
        return record;
    }

    private static String status(JsonNode event) {
        JsonNode data = event.required("data");
        if (data.has("mergedAt")) return "merged";
        return data.required("nativeState").asText().equals("open") ? "open" : "closed";
    }

    private static ArrayNode strings(List<String> values) {
        ArrayNode result = MAPPER.createArrayNode();
        values.forEach(result::add);
        return result;
    }

    private static ArrayNode array(JsonNode... values) {
        ArrayNode result = MAPPER.createArrayNode();
        for (JsonNode value : values) result.add(value);
        return result;
    }

    private static ObjectNode object(Object... values) {
        ObjectNode result = MAPPER.createObjectNode();
        for (int index = 0; index < values.length; index += 2) {
            String key = (String) values[index];
            Object value = values[index + 1];
            if (value instanceof JsonNode node) result.set(key, node);
            else if (value instanceof String text) result.put(key, text);
            else if (value instanceof Integer number) result.put(key, number);
            else throw new IllegalArgumentException("Unsupported JSON value for " + key + ": " + value);
        }
        return result;
    }

    private static String canonicalJson(JsonNode value) throws Exception {
        if (value.isObject()) {
            Map<String, JsonNode> sorted = new LinkedHashMap<>();
            value.fields().forEachRemaining(entry -> sorted.put(entry.getKey(), entry.getValue()));
            List<String> keys = new ArrayList<>(sorted.keySet());
            // The protocol's TypeScript canonicalizer uses String.localeCompare (en-US).
            keys.sort(Collator.getInstance(Locale.US));
            ObjectNode object = MAPPER.createObjectNode();
            for (String key : keys) object.set(key, MAPPER.readTree(canonicalJson(sorted.get(key))));
            return MAPPER.writeValueAsString(object);
        }
        if (value.isArray()) {
            ArrayNode array = MAPPER.createArrayNode();
            for (JsonNode child : value) array.add(MAPPER.readTree(canonicalJson(child)));
            return MAPPER.writeValueAsString(array);
        }
        return MAPPER.writeValueAsString(value);
    }

    private static String sha256(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte item : digest) result.append(String.format("%02x", item));
        return result.toString();
    }
}
