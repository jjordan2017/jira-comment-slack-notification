'use strict';

const
  express = require('express'),
  exphbs = require('express-handlebars'),
  bodyParser = require('body-parser'),
  slack = require('./slack'),
  user = require('./user'),
  jira = require('./jira'),
  utils = require('./utils'),
  passport = require('passport'),
  AtlassianOAuthStrategy = require('passport-atlassian-oauth').Strategy,
  request = require('request'),
  mongoose = require('mongoose'),
  APP_URL = process.env.APP_URL || `http://localhost:5000/`,
  JIRA_URL = process.env.JIRA_URL,
  MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/mongo_test";

mongoose.connect(MONGO_URI, function (err, res) {
  if (err) {
  console.log ('ERROR connecting to: ' + MONGO_URI + '. ' + err);
  } else {
  console.log ('Succeeded connected to: ' + MONGO_URI);
  }
});

var app = express();
app.set('port', process.env.PORT || 5000);

app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(bodyParser.json());
app.use(passport.initialize());
app.use(passport.session());
app.use(require('express-session')({ secret: 'keyboard cat', resave: true, saveUninitialized: true }));

app.engine('handlebars', exphbs({defaultLayout: 'main'}));
app.set('view engine', 'handlebars');

app.get('/signup', function(req, res) {
  res.render('signup');
})

// passport setup for atlassian
// called from route: /auth/atlassian-oauth
passport.use(new AtlassianOAuthStrategy({
  applicationURL: `${JIRA_URL}`,
  callbackURL:`${APP_URL}auth/atlassian-oauth/callback`,
  passReqToCallback: true,
  consumerKey:"neptune-the-doodle",
  consumerSecret:process.env.RSA_PRIVATE_KEY
}, function(req, token, tokenSecret, profile, done) {
    console.log('HELLO')
    process.nextTick(function() {
      console.log(token)
      console.log(tokenSecret)
      console.log(req.session.slackUsername)

      user.create({
        slackUsername: req.session.slackUsername,
        slackUserId: req.session.slackUserId,
        jiraToken: token,
        jiraUsername: profile.username,
        jiraTokenSecret: tokenSecret
      }).then(createdUser => {
        return done(null, createdUser)
      })
    })
  }
));

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});

app.get('/auth', function(req, res) {
  console.log('AUTH')
  user.getBySlackUsername(req.query.slackUsername)
    .then(thisUser => {
      if (thisUser) {
        // save slack username to session to use when saving user after auth
        req.session.slackUsername = req.query.slackUsername
        req.session.slackUserId = req.query.slackUserId
        // send to auth route
        res.redirect('/auth/atlassian-oauth')

      } else {
        // this user already signed up
        res.send(JSON.stringify({user: thisUser}))
      }
    })
})

// auth route uses passport
app.get('/auth/atlassian-oauth',
    passport.authenticate('atlassian-oauth'),
    function (req, res) {
      console.log('ATLASSIAN AUTH')
      res.render('message', {
        successMsg: 'yay!'
      })
        // The request will be redirected to the Atlassian app for authentication, so this
        // function will not be called.
    })

app.get('/auth/atlassian-oauth/callback',
    passport.authenticate('atlassian-oauth', { failureRedirect:'/fail' }),
    function (req, res) {
      console.log("ATLASSIAN AUTH CALLBACK")
      console.log(req.session)
        res.redirect('/?success=true');
    })

app.get('/auth/atlassian-oauth/authorize', function(req, res) {
  console.log('AUTH URL')
  console.log(req.body)
  res.sendStatus(200)
})


app.get('/settings', function(req, res) {
  if (!req.query.slackUsername) {
    res.send(403)
  }
  user.getBySlackUsername(req.query.slackUsername).then(thisUser => {
    console.log(thisUser)
    if (!thisUser) {
      res.sendStatus(403)
    }
    res.render('settings', {
      slackUsername: thisUser.slackUsername,
      jiraUsername: utils.stripJiraMarkupFromUsername(thisUser.jiraUsername)
    })
  }).catch(err => {
    res.sendStatus(403)
  })
})

app.post('/response-from-slack', function(req, res) {
  if (req.body.challenge) {
    res.send(req.body.challenge)
  } else if (req.body.payload) {

    let payload = JSON.parse(req.body.payload)
    console.log("PAYLOAD")
    console.log(payload)

    if (payload.callback_id == 'respond_to_comment') {
      console.log(payload.user.name)
      user.getBySlackUsername(payload.user.name).then(thisUser => {
        console.log(thisUser)
        jira.createTicket(thisUser, {
          project: 'MIKETEST',
          summary: 'testing summary',
          description: 'testing description'
        }).then(ticket => {
          console.log(ticket)
          res.send('Nice work!!')
        })

        //slack.popDialog(thisUser)

      })
    }

  }

    // user.getBySlackUserId(req.body.event.user).then(thisUser => {
    //
    //   res.send(200)
    //
    // })

})

app.post('/user/create', function(req, res) {
  let newUser = {
    slackUsername: req.body.slack.username,
    slackUserId: req.body.slackUserId,
    jiraUsername: req.body.jira.username
  }
  user.create(newUser).then(createdUser => {
    return res.render('settings', {
      slackUsername: createdUser.slackUsername,
      slackUserId: createdUser.slackUserId,
      jiraUsername: utils.stripJiraMarkupFromUsername(createdUser.jiraUsername),
      signUpSuccessMsg: 'Signup Successful!'
    })
  })
})

app.post('/msg-wake-up', function(req, res) {
  if (req.body.challenge) {
    res.send(req.body.challenge)
  } else {
    //wake up!
    console.log('Im up!')
    res.send(200)
  }
})

app.post('/comment-created', function(req, res) {
  let webhookReason = req.body.webhookEvent,
      webhookData = req.body,
      commentBody = req.body.comment.body;

  // continue if the webhook was sent to us because an issue was commented on
  // by someone other than our GitHub Integration
  if (webhookReason === "comment_created" && webhookData.comment.author.displayName != "GitHub Integration") {
    // look for a user mention in the comment
    utils.getUserMentionsFromComment(commentBody).then(userMentions => {
      // for each mentioned user thats signed up for this app, send slack msg
      userMentions.forEach(userMention => {
        // find if there is a user with that jira username in this app's DB
        user.getByJiraUsername(userMention).then((thisUser, index) => {
          // send a slack message to the user
          slack.sendCommentToUser(thisUser.slackUsername, webhookData).then(result => {
            // if this is the last user to msg, send 200 status
            if (userMentions.length === index + 1) {
              res.sendStatus(200)
            }
          })
          .catch(err => { return res.sendStatus(500) })

        })
        .catch(noUser => { return res.sendStatus(200) })

      })

    })
    .catch(noMentions => { return res.sendStatus(200) })
  }

})

app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
module.exports = app;
