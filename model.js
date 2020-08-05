let mongoose = require("mongoose")
let userSchema = new mongoose.Schema({
  user_id: { type: String, require: true, unique: true },
  team_id: String,
  access_token: String,
  enterprise_id: String,
  term_name: String,
  scope: String,
  url: String,
  team: String,
  user: String,
  real_name: String,
  preMessage: String
});

exports.User = mongoose.model("User", userSchema);
