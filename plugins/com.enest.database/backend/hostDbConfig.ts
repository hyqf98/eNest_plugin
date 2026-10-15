import type { DbConnectionConfig } from '@backend/contracts/ssh-db'
export interface HostDbConnectionConfig extends DbConnectionConfig { filePath?: string; sqlitePath?: string }

import type { DbImportPreviewInput, DbImportRunInput } from '@backend/contracts/ssh-db'
export interface HostDbImportPreviewInput extends DbImportPreviewInput { filePath?: string }
export interface HostDbImportRunInput extends DbImportRunInput { filePath?: string }
