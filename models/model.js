class Model {
  constructor({ id }) {
    this.id = id;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }
}

module.exports = Model;
