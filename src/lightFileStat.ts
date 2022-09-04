import { FilePermission, FileStat, FileType } from "vscode";

/**
 * Simple representation of a FileStat based on the information provided.
 */
export class LightFileStat implements FileStat {
    /** @inheritdoc */
    public readonly type: FileType;

    /** @inheritdoc */
    public readonly size: number;

    /** @inheritdoc */
    public readonly ctime: number;

    /** @inheritdoc */
    public readonly mtime: number;

    /** @inheritdoc */
    public readonly permissions?: FilePermission | undefined;

    /**
     * Creates a new FileType that represents a file with the provided information.
     *
     * @param fileSize The size of the file content.
     * @param modifiedDateTime A string that represents when the file was modified.
     * @param createdDateTime A string that represents when the file was created.
     * @param isReadOnly A boolean that represents if this file is considered read-only and cannot be changed.
     */
    public constructor(fileSize: number, modifiedDateTime: string, createdDateTime: string, isReadOnly: boolean) {
        this.type = FileType.File;
        this.size = fileSize;

        if (!createdDateTime) {
            this.ctime = Date.now();
        }
        else {
            const timeValue = Date.parse(createdDateTime);

            this.ctime = isNaN(timeValue) ? Date.now() : timeValue;
        }

        if (!modifiedDateTime) {
            this.mtime = Date.now();
        }
        else {
            const timeValue = Date.parse(modifiedDateTime);

            this.mtime = isNaN(timeValue) ? Date.now() : timeValue;
        }

        if (isReadOnly) {
            this.permissions = FilePermission.Readonly;
        }
    }
}
