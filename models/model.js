class Model {
  constructor({ id }) {
    this.id = id;
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.deletedAt = null;
  }
}

module.exports = Model;
