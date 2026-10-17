export interface StoredLogEntry {
  id: string;
  timestamp: number;
  level: string;
  message: string;
  line: string;
}

export interface NewLogEntry {
  timestamp: number;
  level: string;
  message: string;
}

export interface LogQuery {
  beforeId?: number;
  limit: number;
  level?: string;
  search?: string;
  since?: number;
  until?: number;
}
