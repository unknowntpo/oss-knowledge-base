export interface GitHubProjectProfile {
  readonly owner: string;
  readonly repo: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly label: string;
  readonly sourceInstanceId: string;
  readonly profileVersion: string;
  readonly statusPolicyRef: "github-issue-or-pull-request-status@1";
}

export const githubProjectProfiles: readonly GitHubProjectProfile[] = [
  {
    owner: "apache",
    repo: "kafka",
    projectId: "apache-kafka",
    projectKey: "kafka",
    label: "Apache Kafka",
    sourceInstanceId: "kafka:github",
    profileVersion: "apache-kafka@github-live-1",
    statusPolicyRef: "github-issue-or-pull-request-status@1",
  },
  {
    owner: "apache",
    repo: "datafusion",
    projectId: "apache-datafusion",
    projectKey: "datafusion",
    label: "Apache DataFusion",
    sourceInstanceId: "datafusion:github",
    profileVersion: "apache-datafusion@github-live-1",
    statusPolicyRef: "github-issue-or-pull-request-status@1",
  },
] as const;

/** A non-GitHub source of a project (Spec 012). Keyed by source instance id, not project id. */
export interface CommunitySourceProfile {
  readonly key: "mail" | "jira";
  readonly projectId: string;
  readonly projectKey: string;
  readonly sourceInstanceId: string;
  readonly sourceType: "mailing-list" | "issue-tracker";
  readonly profileVersion: string;
  readonly label: string;
  readonly full: string;
}

export const kafkaMailSource: CommunitySourceProfile = {
  key: "mail",
  projectId: "apache-kafka",
  projectKey: "kafka",
  sourceInstanceId: "kafka:mail:dev",
  sourceType: "mailing-list",
  profileVersion: "apache-kafka@community-live-1",
  label: "dev@",
  full: "dev@kafka.apache.org threads",
};

export const kafkaJiraSource: CommunitySourceProfile = {
  key: "jira",
  projectId: "apache-kafka",
  projectKey: "kafka",
  sourceInstanceId: "kafka:jira",
  sourceType: "issue-tracker",
  profileVersion: "apache-kafka@community-live-1",
  label: "Jira",
  full: "KAFKA Jira issues and comments",
};

export const communitySourceProfiles: readonly CommunitySourceProfile[] = [kafkaMailSource, kafkaJiraSource];

export interface ReferenceMaterializationConfig {
  readonly materializedAt: string;
  readonly activityWindowDays: number;
  readonly projectProfiles: readonly GitHubProjectProfile[];
  /** Absent in pre-Spec 012 fixtures; treated as none. */
  readonly communitySources?: readonly CommunitySourceProfile[];
  readonly materializerRevision: string;
  readonly clusteringRevision: string;
  readonly keyPointRevision: string;
  /** Revision of the deterministic key rules behind Related links and Jira publication. */
  readonly linkRevision?: string;
}

export function defaultReferenceConfig(materializedAt: string): ReferenceMaterializationConfig {
  return {
    materializedAt,
    activityWindowDays: 30,
    projectProfiles: githubProjectProfiles,
    communitySources: communitySourceProfiles,
    materializerRevision: "reference-materializer@2",
    clusteringRevision: "github-thread@1",
    keyPointRevision: "github-source-extract@1",
    linkRevision: "kafka-key-links@1",
  };
}
