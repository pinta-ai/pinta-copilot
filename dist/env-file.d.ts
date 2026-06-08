export declare function envFilePath(): string;
export declare function parseEnvFile(content: string): Record<string, string>;
/** Load the env file (if present) and merge only-unset keys into process.env. */
export declare function loadEnvFile(filePath?: string): void;
