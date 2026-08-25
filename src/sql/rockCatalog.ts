/**
 * The static catalog of Rock's core schema conventions that ships with the
 * extension, and the rules built on top of it: the canonical join path for a
 * foreign key column, and the diagnostic for the classic `PersonId` versus
 * `PersonAliasId` mistake.
 *
 * This is knowledge about Rock, not about a particular server. Table and column
 * lists for a specific database come from the object explorer cache and
 * `Sql/ColumnNames`; what lives here is the part that never changes: what the
 * high traffic tables are for, and how they are meant to be joined. The
 * completion and hover providers combine the two.
 *
 * Nothing here touches vscode, so every rule is unit testable.
 */

import { analyzeSql, SqlAnalysis } from "./sqlContext";
import { bareIdentifier, sqlIdentifierPattern, unquoteIdentifier } from "./sqlLexemes";

/** A core Rock table worth offering as a completion. */
export type RockTable = {
    /** The table name as Rock spells it, without brackets. */
    name: string;

    /** One line of what the table holds, shown as the completion detail. */
    description: string;
};

/** The canonical way to reach the table that a foreign key column points at. */
export type RockJoinPath = {
    /** The foreign key column this path applies to, as Rock spells it. */
    columnName: string;

    /**
     * The join clause to insert, with `{alias}` standing in for the alias or
     * name of the table that owns the column.
     */
    snippetTemplate: string;

    /** Why the join looks the way it does, shown as the completion documentation. */
    explanation: string;
};

/** A join clause ready to insert, with the owning table's alias filled in. */
export type JoinSuggestion = {
    /** The join clause, with the owning alias substituted in. */
    snippet: string;

    /** Why the join looks the way it does. */
    explanation: string;
};

/** How bad a problem the Rock diagnostics found. */
export type DiagnosticSeverity = "warning";

/** A problem found in a piece of SQL by the Rock aware rules. */
export type Diagnostic = {
    /** What is wrong and how to fix it. */
    message: string;

    /** The offset of the first character of the offending text. */
    startOffset: number;

    /** The offset just past the last character of the offending text. */
    endOffset: number;

    /** How bad the problem is. Every Rock rule warns; none of them error. */
    severity: DiagnosticSeverity;
};

/** The placeholder that a join snippet template uses for the owning alias. */
export const joinAliasPlaceholder = "{alias}";

/**
 * The message attached to every `PersonId` versus `PersonAliasId` warning.
 *
 * Worth spelling out in full: the query runs, returns rows and looks correct,
 * and the only symptom is that people who have ever been merged quietly go
 * missing.
 */
export const personAliasMisjoinMessage = "This joins Person.Id directly against a PersonAliasId column. PersonAliasId points at PersonAlias.Id, not Person.Id, so this silently drops every person who has been merged. Join through PersonAlias instead: INNER JOIN PersonAlias pa ON pa.Id = <table>.PersonAliasId INNER JOIN Person p ON p.Id = pa.PersonId";

/**
 * The core Rock tables, in rough order of how often a query touches them.
 *
 * This is a curated shortlist and not a schema dump: Rock has hundreds of
 * tables, and a completion list of hundreds of names is worse than no list at
 * all. Names in brackets in Rock's own documentation (`[Group]`, `[Location]`)
 * are stored here unbracketed; the completion layer adds brackets when the name
 * is a T-SQL reserved word.
 */
export const rockTables: readonly RockTable[] = [
    { name: "Person", description: "One row per person record. Never join to this directly from a PersonAliasId column." },
    { name: "PersonAlias", description: "Maps every historical person identity to the surviving Person. All person foreign keys point here." },
    { name: "Group", description: "Every group, including families, security roles and check-in groups. Reserved word, so write [Group]." },
    { name: "GroupMember", description: "A person's membership in a group, with role and status." },
    { name: "GroupType", description: "The template behind a group: its roles, purpose and check-in behavior." },
    { name: "GroupTypeRole", description: "The roles a group type defines, such as Adult and Child in a family." },
    { name: "GroupLocation", description: "Locations tied to a group, including a family's home address." },
    { name: "Attendance", description: "One row per person per occurrence, with check-in and check-out times." },
    { name: "AttendanceOccurrence", description: "The group, schedule, location and date that Attendance rows hang from." },
    { name: "AttendanceCode", description: "The security codes printed on check-in labels." },
    { name: "FinancialTransaction", description: "One gift or payment, with its date, source and batch." },
    { name: "FinancialTransactionDetail", description: "The per-account amounts that make up a transaction." },
    { name: "FinancialAccount", description: "The fund or account a gift is designated to." },
    { name: "FinancialBatch", description: "The batch a set of transactions was entered or settled in." },
    { name: "FinancialScheduledTransaction", description: "A recurring gift schedule, separate from the transactions it produces." },
    { name: "FinancialPledge", description: "A person's or group's pledge against an account for a date range." },
    { name: "FinancialPaymentDetail", description: "The payment instrument details behind a transaction or schedule." },
    { name: "Campus", description: "A physical campus, referenced by people, groups and transactions." },
    { name: "Location", description: "An address or a named place such as a room. Reserved word, so write [Location]." },
    { name: "Schedule", description: "A service time or recurring schedule, stored as an iCalendar string." },
    { name: "DefinedType", description: "A configurable list, such as Marital Status or Connection Status." },
    { name: "DefinedValue", description: "One entry in a defined type. Every column ending in ValueId points here." },
    { name: "Attribute", description: "The definition of a custom field on any entity type." },
    { name: "AttributeValue", description: "The value of a custom field for one entity, keyed by AttributeId and EntityId." },
    { name: "EntityType", description: "The registry of Rock model types, used wherever a reference is polymorphic." },
    { name: "PhoneNumber", description: "A person's phone numbers, one row each, with the searchable digits in Number." },
    { name: "ConnectionRequest", description: "A person's request against a connection opportunity, with its state and connector." },
    { name: "ConnectionOpportunity", description: "The thing a person can be connected to, such as joining a serving team." },
    { name: "ConnectionRequestActivity", description: "The activity log of a connection request." },
    { name: "PrayerRequest", description: "A submitted prayer request, with its category, approval and flag counts." },
    { name: "ContentChannel", description: "A channel of content items, such as a blog or a sermon series list." },
    { name: "ContentChannelItem", description: "One item in a content channel, with its start and expire dates." },
    { name: "Device", description: "A registered device such as a check-in kiosk or a printer." },
    { name: "Metric", description: "The definition of something measured over time." },
    { name: "MetricValue", description: "One measured value of a metric, with its date and partitions." },
    { name: "BinaryFile", description: "File metadata: name, MIME type and storage location. Contents live in BinaryFileData." },
    { name: "Communication", description: "One sent or pending communication, such as an email or an SMS blast." },
    { name: "CommunicationRecipient", description: "Per-recipient state of a communication: sent, opened, clicked, failed." },
    { name: "InteractionChannel", description: "The broadest grouping of interactions, such as a website or a mobile app." },
    { name: "InteractionComponent", description: "The thing interacted with inside a channel, such as a page or a block." },
    { name: "Interaction", description: "One recorded interaction: a page view, a click, a session event." },
    { name: "InteractionSession", description: "The session that groups a visitor's interactions." },
    { name: "RegistrationInstance", description: "One run of a registration template, such as this year's camp." },
    { name: "Registration", description: "A single registration submitted against an instance, with its registrar." },
    { name: "RegistrationRegistrant", description: "One person registered within a registration." },
    { name: "PersonalDevice", description: "A person's phone or tablet, used for push notifications." },
    { name: "Workflow", description: "One running or completed instance of a workflow type." },
    { name: "WorkflowActivity", description: "One activity within a workflow instance." },
    { name: "WorkflowType", description: "The definition of a workflow: its activities, actions and attributes." },
    { name: "History", description: "The audit trail of changes to entities that have history enabled." },
    { name: "Note", description: "A note attached to any entity, keyed by EntityId and note type." },
    { name: "Tag", description: "A personal or organizational tag, applied through TaggedItem." },
    { name: "Page", description: "A page in Rock's internal or external site structure." },
    { name: "Block", description: "A block placed on a page or a layout, with its settings in AttributeValue." }
];

/**
 * The join paths that are worth spelling out, keyed by the exact column name.
 *
 * Columns that follow an obvious convention are not listed: `GroupTypeId`,
 * `ContentChannelId` and their kind are resolved by
 * {@link suggestJoin}'s suffix rules instead, which keeps this list to the
 * paths where the destination is not simply the column name minus `Id`.
 */
export const rockJoinPaths: readonly RockJoinPath[] = [
    {
        columnName: "PersonAliasId",
        snippetTemplate: `INNER JOIN PersonAlias pa ON pa.Id = ${joinAliasPlaceholder}.PersonAliasId\nINNER JOIN Person p ON p.Id = pa.PersonId`,
        explanation: "Person foreign keys in Rock point at PersonAlias, not Person, so that merged people keep resolving. Always go through PersonAlias to reach the person."
    },
    {
        columnName: "PersonId",
        snippetTemplate: `INNER JOIN Person p ON p.Id = ${joinAliasPlaceholder}.PersonId`,
        explanation: "A PersonId column already points at Person.Id. Only PersonAlias and a handful of internal tables have one; everything else uses PersonAliasId."
    },
    {
        columnName: "OccurrenceId",
        snippetTemplate: `INNER JOIN AttendanceOccurrence ao ON ao.Id = ${joinAliasPlaceholder}.OccurrenceId`,
        explanation: "Attendance carries almost nothing itself. The group, schedule, location and date all come from AttendanceOccurrence."
    },
    {
        columnName: "TransactionId",
        snippetTemplate: `INNER JOIN FinancialTransaction ft ON ft.Id = ${joinAliasPlaceholder}.TransactionId`,
        explanation: "FinancialTransactionDetail rows are the per-account amounts of one FinancialTransaction. Sum the details, and take the date and the giver from the transaction."
    },
    {
        columnName: "AccountId",
        snippetTemplate: `INNER JOIN FinancialAccount fa ON fa.Id = ${joinAliasPlaceholder}.AccountId`,
        explanation: "The fund a gift was designated to lives on the detail row, not on the transaction, because one gift can be split across accounts."
    },
    {
        columnName: "AuthorizedPersonAliasId",
        snippetTemplate: `INNER JOIN PersonAlias pa ON pa.Id = ${joinAliasPlaceholder}.AuthorizedPersonAliasId\nINNER JOIN Person p ON p.Id = pa.PersonId`,
        explanation: "The giver of a transaction or the owner of a scheduled transaction. Like every person reference, it points at PersonAlias."
    },
    {
        columnName: "GroupId",
        snippetTemplate: `INNER JOIN [Group] g ON g.Id = ${joinAliasPlaceholder}.GroupId`,
        explanation: "Group is a T-SQL reserved word, so it always needs brackets. Remember that families are groups too, so filter by GroupTypeId when you mean small groups."
    },
    {
        columnName: "GroupRoleId",
        snippetTemplate: `INNER JOIN GroupTypeRole gtr ON gtr.Id = ${joinAliasPlaceholder}.GroupRoleId`,
        explanation: "A group member's role is a GroupTypeRole, not a GroupRole: roles are defined once on the group type and shared by every group of that type. Adult and Child in a family come from here."
    },
    {
        columnName: "AttributeId",
        snippetTemplate: `INNER JOIN Attribute a ON a.Id = ${joinAliasPlaceholder}.AttributeId`,
        explanation: "An AttributeValue is only meaningful with its Attribute, which carries the key and the entity type the field belongs to."
    },
    {
        columnName: "EntityId",
        snippetTemplate: `INNER JOIN Person p ON p.Id = ${joinAliasPlaceholder}.EntityId /* only valid while ${joinAliasPlaceholder} is filtered to person attributes */`,
        explanation: "EntityId is polymorphic: what it points at depends on the EntityTypeId of the owning Attribute. Filter by Attribute.EntityTypeId first, then join the matching table. There is no foreign key here, so nothing stops a wrong join from returning rows."
    },
    {
        columnName: "EntityTypeId",
        snippetTemplate: `INNER JOIN EntityType et ON et.Id = ${joinAliasPlaceholder}.EntityTypeId`,
        explanation: "EntityType names the Rock model behind a polymorphic reference. Its Name column holds the fully qualified type, such as Rock.Model.Person."
    },
    {
        columnName: "LocationId",
        snippetTemplate: `INNER JOIN [Location] l ON l.Id = ${joinAliasPlaceholder}.LocationId`,
        explanation: "Location is a T-SQL reserved word, so it always needs brackets. Addresses and named rooms are both locations."
    },
    {
        columnName: "BinaryFileId",
        snippetTemplate: `INNER JOIN BinaryFile bf ON bf.Id = ${joinAliasPlaceholder}.BinaryFileId`,
        explanation: "BinaryFile holds the metadata only. Joining BinaryFileData as well pulls the file contents into the result set, which is rarely what you want."
    },
    {
        columnName: "PrimaryFamilyId",
        snippetTemplate: `INNER JOIN [Group] pf ON pf.Id = ${joinAliasPlaceholder}.PrimaryFamilyId`,
        explanation: "Person.PrimaryFamilyId is a denormalized shortcut to the person's family group. Use it instead of walking GroupMember when you only need the family."
    },
    {
        columnName: "GivingLeaderId",
        snippetTemplate: `INNER JOIN Person gl ON gl.Id = ${joinAliasPlaceholder}.GivingLeaderId`,
        explanation: "Person.GivingLeaderId is a PersonId, not an alias id: it names the person whose giving record the household rolls up into."
    }
];

/**
 * The foreign key columns worth knowing about on the highest traffic tables,
 * keyed by table name.
 *
 * This exists for one situation: the cursor is after a `JOIN`, the table it would
 * be joined to is already in the statement, and nobody has looked at that table
 * in the object explorer yet, so there is no column list cached and fetching one
 * per in-scope table is not something a keystroke may do. Rather than offer
 * nothing, the join suggestions fall back to this list.
 *
 * It is deliberately partial in two directions. Only tables a query is likely to
 * start from are listed, and only the columns someone actually joins on: no
 * `CreatedByPersonAliasId`, no `ForeignId`, no audit columns. Anything missing
 * here still appears the moment the real column list is cached, so the cost of
 * leaving a column out is that one suggestion arrives later, not that it is
 * wrong. A column listed here that the server does not have would be worse,
 * which is why the list stays close to Rock's core.
 */
export const rockForeignKeyColumns: Readonly<Record<string, readonly string[]>> = {
    Person: ["PrimaryFamilyId", "MaritalStatusValueId", "ConnectionStatusValueId", "RecordStatusValueId", "RecordTypeValueId", "GivingLeaderId"],
    PersonAlias: ["PersonId"],
    Group: ["GroupTypeId", "CampusId", "ScheduleId"],
    GroupMember: ["GroupId", "PersonId", "GroupRoleId"],
    GroupLocation: ["GroupId", "LocationId", "GroupLocationTypeValueId"],
    Attendance: ["OccurrenceId", "PersonAliasId", "CampusId", "AttendanceCodeId", "DeviceId"],
    AttendanceOccurrence: ["GroupId", "LocationId", "ScheduleId"],
    FinancialTransaction: ["AuthorizedPersonAliasId", "BatchId", "SourceTypeValueId", "TransactionTypeValueId"],
    FinancialTransactionDetail: ["TransactionId", "AccountId", "EntityTypeId"],
    FinancialScheduledTransaction: ["AuthorizedPersonAliasId", "TransactionFrequencyValueId"],
    FinancialPledge: ["PersonAliasId", "AccountId"],
    AttributeValue: ["AttributeId", "EntityId"],
    Attribute: ["EntityTypeId"],
    DefinedValue: ["DefinedTypeId"],
    PhoneNumber: ["PersonId", "NumberTypeValueId"],
    ConnectionRequest: ["PersonAliasId", "ConnectionOpportunityId", "CampusId"],
    PrayerRequest: ["RequestedByPersonAliasId", "CampusId"],
    CommunicationRecipient: ["CommunicationId", "PersonAliasId"],
    Interaction: ["InteractionComponentId", "PersonAliasId"],
    RegistrationRegistrant: ["RegistrationId", "PersonAliasId"],
    Note: ["EntityId"]
};

/**
 * Lists the foreign key columns the catalog knows a table has.
 *
 * @param tableName The table name as written, possibly bracketed and qualified.
 *
 * @returns The curated column names, or an empty array for a table the catalog says nothing about.
 */
export function curatedForeignKeyColumns(tableName: string): string[] {
    const bare = bareIdentifier(tableName).toLowerCase();
    const key = Object.keys(rockForeignKeyColumns).find(name => name.toLowerCase() === bare);

    return key ? [...rockForeignKeyColumns[key]] : [];
}

/**
 * The tables that a `<Name>Id` column resolves to when the name alone does not
 * match a table, keyed by the column name minus its `Id`.
 */
const conventionExceptions: Record<string, string> = {
    Occurrence: "AttendanceOccurrence",
    Transaction: "FinancialTransaction",
    TransactionDetail: "FinancialTransactionDetail",
    Account: "FinancialAccount",
    Batch: "FinancialBatch"
};

/**
 * The table names that need brackets wherever they are written, because T-SQL
 * has claimed the word.
 *
 * One list, matched case insensitively. It used to be two, one here for
 * generated joins and one in `completionItems` for accepted completions, with
 * different contents: `System` was bracketed when it was completed and bare
 * when it was joined, which is not a difference the two questions can
 * legitimately have.
 */
export const reservedTableNames: readonly string[] = ["group", "location", "schedule", "user", "key", "file", "system", "public", "current", "session"];

/**
 * Spells a bare table name the way it should be written into a query.
 *
 * Bare names only: a qualified name such as `dbo.Person` needs each part quoted
 * separately, which is what `quoteQualifiedIdentifier` in `resultFormatting` is
 * for.
 *
 * @param tableName The bare table name.
 *
 * @returns The name, bracketed if T-SQL requires it.
 */
export function writeTableName(tableName: string): string {
    if (reservedTableNames.indexOf(tableName.toLowerCase()) >= 0) {
        return `[${tableName}]`;
    }

    return tableName;
}

/**
 * Finds a table in the static catalog.
 *
 * Brackets, schema qualifiers and casing are all ignored, so `[dbo].[person]`
 * finds `Person`.
 *
 * @param name The table name as written in a query.
 *
 * @returns The catalog entry, or undefined if the table is not one of the core ones.
 */
export function findRockTable(name: string): RockTable | undefined {
    const bare = bareIdentifier(name).toLowerCase();

    return rockTables.find(table => table.name.toLowerCase() === bare);
}

/**
 * Builds the canonical join for a foreign key column.
 *
 * Three rules apply, in order: an exact entry in {@link rockJoinPaths}, the
 * `*PersonAliasId` and `*ValueId` suffix conventions, and finally the plain
 * `<Table>Id` convention when the remaining name matches a core table. A column
 * that matches none of them returns null rather than a guess.
 *
 * The generated snippet spells the column the way Rock does, not the way it was
 * typed, so a completion accepted mid-word does not leave `p.campusid` behind.
 *
 * @param columnName The column name, with or without brackets.
 * @param tableAliasOrName The alias or table name that owns the column, which the snippet is written against.
 *
 * @returns The join to insert, or null if there is no canonical path for this column.
 */
export function suggestJoin(columnName: string, tableAliasOrName: string): JoinSuggestion | null {
    const column = unquoteIdentifier(columnName.trim());

    if (column.length === 0) {
        return null;
    }

    const alias = unquoteIdentifier(tableAliasOrName.trim()) || "t";
    const exact = rockJoinPaths.find(path => path.columnName.toLowerCase() === column.toLowerCase());

    if (exact) {
        return fillJoin(exact.snippetTemplate, exact.explanation, alias);
    }

    if (/PersonAliasId$/i.test(column)) {
        const template = `INNER JOIN PersonAlias pa ON pa.Id = ${joinAliasPlaceholder}.${column}\nINNER JOIN Person p ON p.Id = pa.PersonId`;
        const explanation = `${column} points at PersonAlias.Id. Reaching Person means going through PersonAlias, which is what keeps merged people resolving.`;

        return fillJoin(template, explanation, alias);
    }

    if (/ValueId$/i.test(column)) {
        const template = `INNER JOIN DefinedValue dv ON dv.Id = ${joinAliasPlaceholder}.${column}`;
        const explanation = `${column} is a defined value reference. Its Value and Description come from DefinedValue, and the list it belongs to from DefinedValue.DefinedTypeId.`;

        return fillJoin(template, explanation, alias);
    }

    if (!/.Id$/i.test(column)) {
        return null;
    }

    const stem = column.substring(0, column.length - 2);
    const exception = Object.keys(conventionExceptions).find(key => key.toLowerCase() === stem.toLowerCase());
    const target = exception ? conventionExceptions[exception] : findRockTable(stem)?.name;

    if (!target) {
        return null;
    }

    const canonicalColumn = `${exception ?? findRockTable(stem)?.name ?? stem}Id`;
    const written = writeTableName(target);
    const targetAlias = aliasFor(target);
    const template = `INNER JOIN ${written} ${targetAlias} ON ${targetAlias}.Id = ${joinAliasPlaceholder}.${canonicalColumn}`;
    const explanation = `${canonicalColumn} points at ${target}.Id.`;

    return fillJoin(template, explanation, alias);
}

/**
 * Finds every place a query joins `Person.Id` straight to a `*PersonAliasId`
 * column.
 *
 * The rule is deliberately narrow, because a false positive here trains people
 * to ignore the warning. A comparison is flagged only when both sides are
 * qualified, one side resolves through the statement's own `FROM` and `JOIN`
 * clauses to the `Person` table and names the `Id` column, and the other side
 * names a column ending in `PersonAliasId`. If either alias is unknown, or the
 * `Id` side resolves to `PersonAlias` rather than `Person`, nothing is
 * reported. Comparisons inside strings and comments are invisible, because the
 * scan runs against the masked text.
 *
 * @param sqlText The SQL text to check.
 * @param analysis The analysis of that text, when the caller already has one. Masking the same document twice per keystroke is the thing this avoids.
 *
 * @returns One diagnostic per offending comparison, in document order.
 */
export function findPersonAliasMisjoins(sqlText: string, analysis?: SqlAnalysis): Diagnostic[] {
    const { masked, aliases } = analysis ?? analyzeSql(sqlText);
    const diagnostics: Diagnostic[] = [];
    const comparison = new RegExp(`(${sqlIdentifierPattern})\\s*\\.\\s*(${sqlIdentifierPattern})\\s*=\\s*(${sqlIdentifierPattern})\\s*\\.\\s*(${sqlIdentifierPattern})`, "g");
    let match = comparison.exec(masked);

    while (match) {
        const left = { owner: unquoteIdentifier(match[1]), column: unquoteIdentifier(match[2]) };
        const right = { owner: unquoteIdentifier(match[3]), column: unquoteIdentifier(match[4]) };

        if (isMisjoin(left, right, aliases) || isMisjoin(right, left, aliases)) {
            diagnostics.push({
                message: personAliasMisjoinMessage,
                startOffset: match.index,
                endOffset: match.index + match[0].length,
                severity: "warning"
            });
        }

        match = comparison.exec(masked);
    }

    return diagnostics;
}

/**
 * Determines if one side of a comparison is `Person.Id` and the other side is a
 * person alias column.
 *
 * @param personSide The side being tested as `Person.Id`.
 * @param aliasSide The side being tested as a `*PersonAliasId` column.
 * @param aliases The alias map of the statement.
 *
 * @returns True if this pairing is the mistake.
 */
function isMisjoin(personSide: { owner: string; column: string }, aliasSide: { owner: string; column: string }, aliases: Map<string, string>): boolean {
    if (personSide.column.toLowerCase() !== "id") {
        return false;
    }

    if (!/PersonAliasId$/i.test(aliasSide.column)) {
        return false;
    }

    const resolved = aliases.get(personSide.owner.toLowerCase());

    if (resolved === undefined) {
        return false;
    }

    return resolved.toLowerCase() === "person";
}

/**
 * Fills the owning alias into a join template.
 *
 * @param template The snippet template.
 * @param explanation The explanation that goes with it.
 * @param alias The alias or table name that owns the column.
 *
 * @returns The finished suggestion.
 */
function fillJoin(template: string, explanation: string, alias: string): JoinSuggestion {
    return {
        snippet: template.split(joinAliasPlaceholder).join(alias),
        explanation: explanation
    };
}

/**
 * Builds the short alias that a generated join gives its table.
 *
 * @param tableName The table being joined.
 *
 * @returns A lower cased alias, made of the capital letters of the table name.
 */
function aliasFor(tableName: string): string {
    const initials = tableName.replace(/[^A-Z]/g, "").toLowerCase();

    return initials.length > 0 ? initials : tableName.substring(0, 1).toLowerCase();
}
