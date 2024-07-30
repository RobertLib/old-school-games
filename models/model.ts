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
