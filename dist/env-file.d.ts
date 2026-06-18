import { parseEnvFile } from "@pinta-ai/core";
export { parseEnvFile };
export declare function envFilePath(): string;
/** Load the env file (if present) and merge only-unset keys into process.env. */
export declare function loadEnvFile(filePath?: string): void;
