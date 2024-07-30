/**
 * Only "news" soft-deletes; every other table hard-deletes, so "deletedAt" is
 * undefined on their rows (see 0022_drop_unused_deleted_at.sql, which removed
 * the always-NULL columns that made it look otherwise).
 */
export interface ModelData {
  id: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt?: Date | string | null;
}

export default class Model {
  id: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt?: Date | string | null;

  constructor(data: ModelData) {
    this.id = data.id;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.deletedAt = data.deletedAt;
  }
}
