// `cp _env .env` then modify it
// See https://github.com/motdotla/dotenv
const config = require("dotenv").config().parsed;
// Overwrite env variables anyways
for (const k in config) {
  process.env[k] = config[k];
}

const mongoose = require("mongoose");
const model = require("./model.js");

const { LogLevel } = require("@slack/logger");
const logLevel = process.env.SLACK_LOG_LEVEL || LogLevel.DEBUG;

const request = require('request');

const { App, ExpressReceiver } = require("@slack/bolt");
// If you deploy this app to FaaS, turning this on is highly recommended
// Refer to https://github.com/slackapi/bolt/issues/395 for details

// FaaSで実行する場合はtrueにセット(envはStringとして読み込まれる為このような比較)
const processBeforeResponse = process.env.PROCESS_BEFORE_RESPONSE === "true";

// DB
mongoose.connect(process.env.DB_URI || "mongodb://root:example@localhost:27077/slack?authSource=admin",
  {
    useNewUrlParser: true,
    useCreateIndex: true,
    useUnifiedTopology: true
  }).catch(e => console.log("MongoDB connection Error:", e));
let db = mongoose.connection;
db.on("error", console.error.bind(console, "connection error:"));
db.once("open", () => console.log("mongoDB Connected."));

// Manually instantiate to add external routes afterwards
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  logLevel,
  receiver,
});

// Request dumper middleware for easier debugging
if (process.env.SLACK_REQUEST_LOG_ENABLED === "1") {
  app.use(async (args) => {
    const copiedArgs = JSON.parse(JSON.stringify(args));
    copiedArgs.context.botToken = 'xoxb-***';
    if (copiedArgs.context.userToken) {
      copiedArgs.context.userToken = 'xoxp-***';
    }
    copiedArgs.client = {};
    copiedArgs.logger = {};
    args.logger.debug(
      "Dumping request data for debugging...\n\n" +
      JSON.stringify(copiedArgs, null, 2) +
      "\n"
    );
    const result = await args.next();
    args.logger.debug("next() call completed");
    return result;
  });
}

// ---------------------------------------------------------------
// Start coding here..
// see https://slack.dev/bolt/

// https://api.slack.com/apps/{APP_ID}/event-subscriptions
app.event("app_mention", async ({ logger, client, event, say }) => {

});

app.event("app_home_opened", async ({ logger, client, event, say }) => {

});

app.command("/qa-info", async ({ logger, client, ack, body }) => {
  const commands = body["text"].split(" ");
  const scopes = "identify,users:read,chat:write:user,reactions:write,reactions:read";
  const usage = "USAGE: `/qa-info [auth|message|logout|help]`";
  //console.log(commands);
  try {
    if (commands[0] === "help") {
      await ack(usage + "\nデフォルトでは、 `{名前}です。` とメッセージの頭につける設定になっています。\n `/qa-info auth` (認証リンクを生成する) \n `/qa-info message` ( デフォルトメッセージを確認する) \n `/qa-info message [hoge]` (デフォルトメッセージをhogeの内容で設定する) \n 認証後はメッセージショートカットからモーダルを起動することができます。(:対応中:, :対応済2:などが付けられているメッセージには反応しません");
    } else if (commands[0] === "auth") {
      let message = ":point_right:  "
        + `<https://slack.com/oauth/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=${scopes}&redirect_url=${process.env.REDIRECT_URI}|Click here!!>` + "  :point_left:";
      await ack(message);
    } else if (commands[0] === "message") {
      const user = await model.User.findOne({ user_id: body["user_id"] }, (err, res) => {
        if (err) {
          logger.info("DB Error");
          return null;
        }
        return res;
      });
      //console.log(commands.length);
      if (commands.length >= 2) {
        // set message
        let message = commands[1];
        //console.log(message);
        if (!user || !user["access_token"]) {
          ack(`登録されていません。`);
          return;
        } else {
          let res = await model.User.findOneAndUpdate({ user_id: body.user_id }, { $set: { preMessage: message } }, (err, res) => {
            if (err) {
              logger.info(err);
              return null;
            }
            return res;
          });
          ack(`デフォルトメッセージを\n> ${res.preMessage}\nに設定しました。`);
          return;
        }
      } else {
        // show message
        if (!user || !user["access_token"]) {
          ack(`登録されていません。 /qa-info auth　と入力してください。`);
          return;
        } else {
          ack(`あなたのデフォルトメッセージは\n> ${user.preMessage}\nです。`);
          return;
        }
      }
    } else if (commands[0] === "logout") {
      // logout
      await ack(`まだログアウト機能は実装されていません。`);
    } else {
      await ack(usage);
    }
  } catch (e) {
    logger.error("command error:\n\n" + e + "\n");
    await ack("ERROR: can't parse command.\n" + usage);
  }
});

app.shortcut("qa-info", async ({ logger, client, body, ack }) => {
  await ack();
  const user = await model.User.findOne({ user_id: body["user"]["id"] }, (err, res) => {
    if (err) {
      logger.info("DB Error");
      return null;
    }
    return res;
  });
  if (!user || !user["access_token"]) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: "アクセストークンによる認可が行われていないので、使用できません。\n Slackの入力欄に `/qa-info auth` と入力し、現れたリンクを使って認可してください。"
    }
    )
    console.log("未登録: " + body.user.id);
    return;
  }
  await openModal({ logger, client, ack, body }, user);
});



async function openModal({ logger, client, ack, body }, user) {
  try {
    const messageType = body.message.subtype;
    let message = body.message.text;

    const users = await getUserList(message, client, user);
    //console.log(body);
    if (messageType === "bot_message" && body.message.bot_id === "B0141BXEWUX") {
      message = body.message.blocks[1].text.text;

      let reaction = await client.reactions.get({
        "token": user.access_token,
        "channel": body.channel.id,
        "timestamp": body.message_ts
      });
      if (reaction.message.reactions) {
        for (r of reaction.message.reactions) {
          if (r.name === "対応中" || r.name === "対応済" || r.name === "対応済2") {
            await client.chat.postMessage({
              channel: body.user.id,
              text: ":対応中: :対応済: :対応済2:　のいずれかのリアクションがついているメッセージなので、DMに送信することはできません。"
            });
            return;
          }
        }
      }
    } else {
      let user_info = await client.users.info({
        user: body.message.user
      });
      //console.log(user_info);
      if (user_info && user_info.user && user_info.user.real_name) {
        users.push({
          "text": {
            "type": "plain_text",
            "text": user_info.user.real_name,
            "emoji": true
          },
          "value": body.message.user
        });
      }
    }

    message = message.trim().split("\n").join("\n> ");

    const preMessage = user.preMessage;

    const res = await client.views.open({
      "trigger_id": body.trigger_id,
      "view": {
        "type": "modal",
        "callback_id": "qa-info",
        "private_metadata": JSON.stringify({
          messageType: messageType,
          message: message,
          channel_id: body.channel.id,
          ts: body.message_ts
        }),
        "title": {
          "type": "plain_text",
          "text": "DMに引用送信する",
          "emoji": true
        },
        "submit": {
          "type": "plain_text",
          "text": "Submit",
          "emoji": true
        },
        "close": {
          "type": "plain_text",
          "text": "Cancel",
          "emoji": true
        },
        "blocks": [
          {
            "type": "divider"
          },
          {
            "type": "input",
            "block_id": "pre_message",
            "element": {
              "action_id": "input",
              "type": "plain_text_input",
              "initial_value": preMessage,
              "multiline": true
            },
            "label": {
              "type": "plain_text",
              "text": "メッセージ",
              "emoji": true
            }
          },
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `> ${message}`
            }
          },
          {
            "type": "divider"
          },
          {
            "type": "input",
            "block_id": "to",
            "element": {
              "type": "static_select",
              "placeholder": {
                "type": "plain_text",
                "text": "Select an item",
                "emoji": true
              },
              "action_id": "input",
              "options": users,
              "initial_option": users[0]
            },
            "label": {
              "type": "plain_text",
              "text": "共有先",
              "emoji": true
            }
          }
        ]
      }
    })
  } catch (e) {
    console.log(e);
  }
}

async function getUserList(message, client, user) {
  const list = message.match(/<@\w+>/g);
  let ans = [];
  for (i in list) {
    const uid = list[i].match(/\w+/)[0];
    const info = await client.users.info({
      user: uid
    });
    const u_name = info.user.real_name;
    ans.push(
      {
        "text": {
          "type": "plain_text",
          "text": u_name,
          "emoji": true
        },
        "value": uid
      }
    )
  }
  ans.push({
    "text": {
      "type": "plain_text",
      "text": user.real_name,
      "emoji": true
    },
    "value": user.user_id
  });
  return ans;
}

app.view("qa-info", async ({ logger, client, body, ack }) => {
  ack();
  // 登録チェック
  const user = await model.User.findOne({ user_id: body["user"]["id"] }, (err, res) => {
    if (err) {
      logger.info("database error(submit):\n\n", err);
      return null;
    }
    return res;
  });
  if (!user || !user["access_token"]) {
    logger.info("unregistered(submit)");
    return;
  }

  // query parse
  const stateValue = body.view.state.values;
  const user_id = stateValue.to.input.selected_option.value;
  const preMessage = stateValue.pre_message.input.value;
  const metadata = JSON.parse(body.view.private_metadata);
  const message = metadata.message;
  // 処理

  if (metadata.messageType === "bot_message") {
    let reaction = await client.reactions.get({
      "token": user.access_token,
      "channel": metadata.channel_id,
      "timestamp": metadata.ts
    }).catch((e) => {
      logger.error("reaction.get(submit):\n", e);
      return null;
    });
    if (reaction && reaction.message && reaction.message.reactions) {
      for (r of reaction.message.reactions) {
        if (r.name === "対応中" || r.name === "対応済" || r.name === "対応済2") {
          await client.chat.postMessage({
            channel: body.user.id,
            text: ":対応中: :対応済: :対応済2:　のいずれかのリアクションがついているメッセージなので、DMに送信することはできませんでした。"
          });
          return;
        }
      }
    }
  }
  await client.chat.postMessage({
    "token": user.access_token,
    "channel": user_id,
    "text": preMessage + "\n\n>" + message
  }).catch(logger.error);

  if (metadata.messageType === "bot_message") {
    await client.reactions.add({
      "token": user.access_token,
      "channel": metadata.channel_id,
      "timestamp": metadata.ts,
      "name": "対応中"
    }).catch(logger.error);
  }
});

// ---------------------------------------------------------------

// root
receiver.app.get("/", (_req, res) => {
  res.send("BOLT APP");
});

receiver.app.get("/oauth", (_req, res) => {
  const code = _req.query["code"];
  request({
    url: "https://slack.com/api/oauth.access",
    method: "POST",

    form: {
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code: code,
      redirect_uri: process.env.REDIRECT_URI,
    }
  }, (error, response, body) => {
    // レスポンスからアクセストークンを取得する
    const param = JSON.parse(body);
    console.log(body);
    const access_token = param['access_token']; // アクセストークン

    // ユーザIDを取得するためのリクエスト
    request("https://slack.com/api/auth.test", {
      method: "POST",
      form: {
        token: access_token
      }
    }, (error, response, body) => {
      const user = JSON.parse(body);
      request("https://slack.com/api/users.info", {
        method: "POST",
        form: {
          token: access_token,
          user: param["user_id"]
        }
      }, (error, response, body) => {
        //console.log(body);
        try {
          const us = JSON.parse(body);
          let userInfo = { ...param, ...user };
          console.log(us);
          userInfo["real_name"] = us.user.real_name;
          const rName = us.user.real_name.split("(")[0];
          userInfo["preMessage"] = `プロ実スタッフの${rName}です。`;
          console.log(userInfo);
          model.User.updateOne({ user_id: userInfo["user_id"] }, userInfo, { upsert: true }, (err) => {
            if (err) console.log(err)
          });
          res.send("認証が完了しました。（あとでページ作る？）")
        } catch (e) {
          console.log(error);
          console.log(e);
          res.send("認証エラー");
        }
        //res.redirect(301, "slack://open");
      });
    });
  });
});

// root
(async () => {
  await app.start(process.env.PORT || 8686);
  console.log("⚡️ Bolt app is running! PORT:" + process.env.PORT);
})();
