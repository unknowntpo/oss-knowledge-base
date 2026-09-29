package dev.ossknowledgebase.cluster;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.apache.flink.table.api.EnvironmentSettings;
import org.apache.flink.table.api.TableEnvironment;
import org.apache.flink.types.Row;
import org.apache.flink.util.CloseableIterator;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

class ClusterSliceIT {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    @Timeout(value = 120)
    void replaysFlussLogThroughFlinkCurrentStateAndExportsIndependentCandidate() throws Exception {
        Assumptions.assumeTrue(Boolean.getBoolean("fluss.it"), "run through scripts/run-cluster-slice.ts");
        String bootstrapServers = requiredProperty("fluss.bootstrap.servers");
        String database = requiredProperty("fluss.database");
        Path fixturePath = Path.of(requiredProperty("fluss.fixture"));
        Path candidatePath = Path.of(requiredProperty("fluss.candidate"));
        JsonNode fixture = MAPPER.readTree(fixturePath.toFile());
        List<JsonNode> events = new ArrayList<>();
        fixture.required("events").forEach(events::add);
        assertEquals(5, events.size(), "Spec 004 fixture changed; update assertions deliberately");

        TableEnvironment firstRun = environment(bootstrapServers);
        awaitCluster(firstRun);
        firstRun.executeSql("CREATE DATABASE `" + database + "`").await();
        firstRun.executeSql("USE `" + database + "`");
        createTables(firstRun);
        insertEvents(firstRun, events.subList(0, 2));
        materializeCurrent(firstRun, 2);
        assertEquals(2, scalarLong(firstRun, "SELECT COUNT(*) FROM current_events"));

        // A new TableEnvironment represents a restarted client/job boundary.
        TableEnvironment resumedRun = environment(bootstrapServers);
        awaitCluster(resumedRun);
        resumedRun.executeSql("USE `" + database + "`");
        List<JsonNode> retryAndRemainder = List.of(
                events.get(4), events.get(3), events.get(2),
                events.get(1), events.get(0),
                events.get(4), events.get(3), events.get(2));
        insertEvents(resumedRun, retryAndRemainder);
        materializeCurrent(resumedRun, 10);

        assertEquals(10, scalarLong(resumedRun, "SELECT COUNT(*) FROM event_log"));
        assertEquals(5, scalarLong(resumedRun, "SELECT COUNT(*) FROM current_events"));
        assertEachEventObservedTwice(resumedRun, events);
        List<JsonNode> currentEvents = readCurrentEvents(resumedRun, events);
        assertEquals(5, currentEvents.size());

        JsonNode candidate = IndependentFeedMaterializer.materialize(fixture, currentEvents);
        Files.createDirectories(candidatePath.getParent());
        MAPPER.writerWithDefaultPrettyPrinter().writeValue(candidatePath.toFile(), candidate);
        assertTrue(candidate.required("digest").asText().startsWith("sha256:"));

        resumedRun.executeSql("USE CATALOG default_catalog");
        resumedRun.executeSql("DROP DATABASE fluss_catalog.`" + database + "` CASCADE").await();
    }

    private static TableEnvironment environment(String bootstrapServers) {
        TableEnvironment table = TableEnvironment.create(EnvironmentSettings.newInstance().inBatchMode().build());
        var configuration = table.getConfig().getConfiguration();
        configuration.setString("parallelism.default", "1");
        configuration.setString("table.dml-sync", "true");
        String restAddress = System.getProperty("flink.rest.address");
        if (restAddress != null && !restAddress.isBlank()) {
            configuration.setString("execution.target", "remote");
            configuration.setString("rest.address", restAddress);
            configuration.setInteger("rest.port", Integer.getInteger("flink.rest.port", 8081));
        }
        table.executeSql("CREATE CATALOG fluss_catalog WITH ('type' = 'fluss', 'bootstrap.servers' = '"
                + sql(bootstrapServers) + "')");
        table.executeSql("USE CATALOG fluss_catalog");
        return table;
    }

    private static void awaitCluster(TableEnvironment table) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(90).toNanos();
        Throwable lastFailure = null;
        while (System.nanoTime() < deadline) {
            try (CloseableIterator<Row> ignored = table.executeSql("SHOW DATABASES").collect()) {
                ignored.hasNext();
                return;
            } catch (Throwable failure) {
                lastFailure = failure;
                Thread.sleep(250);
            }
        }
        throw new AssertionError("Fluss cluster did not become ready", lastFailure);
    }

    private static void createTables(TableEnvironment table) throws Exception {
        table.executeSql("""
                CREATE TABLE event_log (
                  project_id STRING NOT NULL,
                  source_instance_id STRING NOT NULL,
                  entity_id STRING NOT NULL,
                  event_id STRING NOT NULL,
                  source_timestamp STRING NOT NULL,
                  source_cursor STRING NOT NULL,
                  payload_json STRING NOT NULL
                ) WITH ('bucket.num' = '1')
                """).await();
        table.executeSql("""
                CREATE TABLE current_events (
                  project_id STRING NOT NULL,
                  source_instance_id STRING NOT NULL,
                  entity_id STRING NOT NULL,
                  event_id STRING NOT NULL,
                  source_timestamp STRING NOT NULL,
                  source_cursor STRING NOT NULL,
                  payload_json STRING NOT NULL,
                  PRIMARY KEY (project_id, source_instance_id, entity_id) NOT ENFORCED
                ) WITH ('bucket.num' = '1')
                """).await();
    }

    private static void insertEvents(TableEnvironment table, List<JsonNode> events) throws Exception {
        List<String> values = new ArrayList<>();
        for (JsonNode event : events) {
            values.add("('" + sql(event.required("projectId").asText())
                    + "','" + sql(event.required("sourceInstanceId").asText())
                    + "','" + sql(event.required("entityId").asText())
                    + "','" + sql(event.required("id").asText())
                    + "','" + sql(event.required("sourceTimestamp").asText())
                    + "','" + sql(event.required("sourceCursor").asText())
                    + "','" + sql(event.toString()) + "')");
        }
        table.executeSql("INSERT INTO event_log VALUES " + String.join(",", values)).await();
    }

    private static void materializeCurrent(TableEnvironment table, int limit) throws Exception {
        table.executeSql("""
                INSERT INTO current_events
                SELECT project_id, source_instance_id, entity_id, event_id,
                       source_timestamp, source_cursor, payload_json
                FROM event_log LIMIT %d
                """.formatted(limit)).await();
    }

    private static long scalarLong(TableEnvironment table, String query) throws Exception {
        try (CloseableIterator<Row> rows = table.executeSql(query).collect()) {
            assertTrue(rows.hasNext(), "Expected one result row for " + query);
            return ((Number) rows.next().getField(0)).longValue();
        }
    }

    private static void assertEachEventObservedTwice(TableEnvironment table, List<JsonNode> events) throws Exception {
        Map<String, Long> counts = new HashMap<>();
        try (CloseableIterator<Row> rows = table.executeSql(
                "SELECT event_id FROM event_log LIMIT 10").collect()) {
            for (int observed = 0; observed < 10; observed++) {
                assertTrue(rows.hasNext(), "Event log ended before 10 records");
                Row row = rows.next();
                counts.merge((String) row.getField(0), 1L, Long::sum);
            }
        }
        assertEquals(events.size(), counts.size());
        for (JsonNode event : events) assertEquals(2L, counts.get(event.required("id").asText()));
    }

    private static List<JsonNode> readCurrentEvents(TableEnvironment table, List<JsonNode> expected) throws Exception {
        List<JsonNode> events = new ArrayList<>();
        for (JsonNode event : expected) {
            String query = "SELECT payload_json FROM current_events WHERE project_id = '"
                    + sql(event.required("projectId").asText()) + "' AND source_instance_id = '"
                    + sql(event.required("sourceInstanceId").asText()) + "' AND entity_id = '"
                    + sql(event.required("entityId").asText()) + "'";
            try (CloseableIterator<Row> rows = table.executeSql(query).collect()) {
                if (rows.hasNext()) events.add(MAPPER.readTree((String) rows.next().getField(0)));
            }
        }
        return events;
    }

    private static String requiredProperty(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Missing -D" + name);
        return value;
    }

    private static String sql(String value) {
        return value.replace("'", "''");
    }
}
