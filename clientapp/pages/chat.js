/*global $, app, me, client*/
"use strict";

var _ = require('underscore');
var StayDown = require('staydown');
var XMPP = require('stanza.io');
var LocalMedia = require('localmedia');
var attachMediaStream = require('attachmediastream');
var BasePage = require('./base');
var templates = require('../templates');
var MessageModel = require('../models/message');
var embedIt = require('../helpers/embedIt');
var htmlify = require('../helpers/htmlify');

module.exports = BasePage.extend({
    template: templates.pages.chat,
    initialize: function (spec) {
        this.editMode = false;
        this.model.fetchHistory();

        this.listenTo(this, 'pageloaded', this.handlePageLoaded);
        this.listenTo(this, 'pageunloaded', this.handlePageUnloaded);

        this.listenTo(this.model.messages, 'change', this.refreshModel);
        this.listenTo(this.model.messages, 'sort', this.renderCollection);

        this.render();
    },
    events: {
        'keydown textarea': 'handleKeyDown',
        'keyup textarea': 'handleKeyUp',
        'click .call': 'handleCallClick',
        'click .accept': 'handleAcceptClick',
        'click .end': 'handleEndClick',
        'click .mute': 'handleMuteClick'
    },
    srcBindings: {
        avatar: 'header .avatar',
        streamUrl: 'video.remote'
    },
    textBindings: {
        displayName: 'header .name',
        formattedTZO: 'header .tzo',
        status: 'header .status'
    },
    classBindings: {
        chatState: 'header',
        idle: 'header',
        show: 'header',
        onCall: '.conversation'
    },
    show: function (animation) {
        BasePage.prototype.show.apply(this, [animation]);
        this.sendChatState('active');
    },
    hide: function () {
        BasePage.prototype.hide.apply(this);
        this.sendChatState('inactive');
    },
    render: function () {
        if (this.rendered) return this;
        var self = this;

        this.rendered = true;

        this.renderAndBind();

        this.$chatInput = this.$('.chatBox textarea');
        this.$chatBox = this.$('.chatBox');
        this.$messageList = this.$('.messages');

        this.staydown = new StayDown({target: this.$messageList[0], interval: 500});
        this.renderCollection();

        this.listenTo(this.model.messages, 'add', this.handleChatAdded);
        this.listenToAndRun(this.model, 'change:jingleResources', this.handleJingleResourcesChanged);

        $(window).on('resize', _.bind(this.resizeInput, this));

        this.registerBindings(me, {
            srcBindings: {
                streamUrl: 'video.local'
            }
        });

        return this;
    },
    handlePageLoaded: function () {
        this.staydown.checkdown();
        this.resizeInput();
    },
    handleCallClick: function (e) {
        e.preventDefault();
        this.model.call();
        return false;
    },
    renderCollection: function () {
        var self = this;
        this.$messageList.empty();
        this.model.messages.each(function (model, i) {
            self.appendModel(model);
        });
        this.staydown.checkdown();
    },
    handleKeyDown: function (e) {
        if (e.which === 13 && !e.shiftKey) {
            this.sendChat();
            e.preventDefault();
            return false;
        } else if (e.which === 38 && this.$chatInput.val() === '' && this.model.lastSentMessage) {
            this.editMode = true;
            this.$chatInput.addClass('editing');
            this.$chatInput.val(this.model.lastSentMessage.body);
            e.preventDefault();
            return false;
        } else if (e.which === 40 && this.editMode) {
            this.editMode = false;
            this.$chatInput.removeClass('editing');
            e.preventDefault();
            return false;
        } else if (!e.ctrlKey && !e.metaKey) {
            if (!this.typing || this.paused) {
                this.typing = true;
                this.paused = false;
                this.$chatInput.addClass('typing');
                this.sendChatState('composing');
            }
        }
    },
    handleKeyUp: function (e) {
        this.resizeInput();
        if (this.typing && this.$chatInput.val().length === 0) {
            this.typing = false;
            this.$chatInput.removeClass('typing');
            this.sendChatState('active');
        } else if (this.typing) {
            this.pausedTyping();
        }
    },
    pausedTyping: _.debounce(function () {
        if (this.typing && !this.paused) {
            this.paused = true;
            this.sendChatState('paused');
        }
    }, 3000),
    sendChatState: function (state) {
        if (!this.model.supportsChatStates) return;
        client.sendMessage({
            to: this.model.lockedResource || this.model.jid,
            chatState: state
        });
    },
    sendChat: function () {
        var message;
        var val = this.$chatInput.val();

        if (val) {
            this.staydown.intend_down = true;

            var links = _.map(htmlify.collectLinks(val), function (link) {
                return {url: link};
            });

            message = {
                id: client.nextId(),
                to: new XMPP.JID(this.model.lockedResource || this.model.jid),
                type: 'chat',
                body: val,
                requestReceipt: true,
                oobURIs: links
            };
            if (this.model.supportsChatStates) {
                message.chatState = 'active';
            }
            if (this.editMode) {
                message.replace = this.model.lastSentMessage.id;
            }

            client.sendMessage(message);

            // Prep message to create a Message model
            message.from = me.jid;
            message.mid = message.id;
            delete message.id;

            if (this.editMode) {
                this.model.lastSentMessage.correct(message);
            } else {
                this.model.lastSentMessage = this.model.addMessage(message);
            }
        }
        this.editMode = false;
        this.typing = false;
        this.paused = false;
        this.$chatInput.removeClass('typing');
        this.$chatInput.removeClass('editing');
        this.$chatInput.val('');
    },
    handleChatAdded: function (model) {
        this.appendModel(model, true);
    },
    refreshModel: function (model) {
        var existing = this.$('#chat' + model.cid);
        existing.replaceWith(model.partialTemplateHtml);
    },
    handleJingleResourcesChanged: function (model, val) {
        var resources = val || this.model.jingleResources;
        this.$('button.call').prop('disabled', !resources.length);
    },
    appendModel: function (model, preload) {
        var self = this;
        var isGrouped = model.shouldGroupWith(this.lastModel);
        var newEl, first, last;

        if (isGrouped) {
            newEl = $(model.partialTemplateHtml);
            last = this.$messageList.find('li').last();
            last.find('.messageWrapper').append(newEl);
            last.addClass('chatGroup');
            this.staydown.checkdown();
        } else {
            newEl = $(model.templateHtml);
            this.staydown.append(newEl[0]);
        }
        // [FIXME] embedIt(newEl);
        this.lastModel = model;
    },
    handleAcceptClick: function (e) {
        e.preventDefault();
        var self = this;

        // [FIXME] this.$('button.accept').prop('disabled', true);
        if (this.model.jingleCall.jingleSession.state == 'pending') {
            if (!client.jingle.localStream) {

                var localMedia = client.localMedia = new LocalMedia();

                localMedia.on('localStream', function (stream) {
                    attachMediaStream(stream, document.getElementById('localVideo'), {
                        mirror: true,
                        muted: true
                    });
                });

                localMedia.start(null, function (err, stream) {
                    if (err) {
                        self.model.jingleCall.end({
                            condition: 'decline'
                        });
                    } else {
                        client.sendPresence({to: new XMPP.JID(self.model.jingleCall.jingleSession.peer) });
                        self.model.jingleCall.jingleSession.addStream(stream);
                        self.model.jingleCall.jingleSession.accept();
                    }
                });
            } else {
                client.sendPresence({to: new XMPP.JID(this.model.jingleCall.jingleSession.peer) });
                this.model.jingleCall.jingleSession.accept();
            }
        }
        return false;
    },
    handleEndClick: function (e) {
        e.preventDefault();
        var condition = 'success';
        if (this.model.jingleCall) {
            if (this.model.jingleCall.jingleSession && this.model.jingleCall.jingleSession.state == 'pending') {
                condition = 'decline';
            }
            this.model.jingleCall.end({
                condition: condition
            });
        }
        return false;
    },
    handleMuteClick: function (e) {
        return false;
    },
    resizeInput: _.throttle(function () {
        var height;
        var scrollHeight;
        var newHeight;
        var newPadding;
        var paddingDelta;
        var maxHeight = 102;

        this.$chatInput.removeAttr('style');
        height = this.$chatInput.height() + 10;
        scrollHeight = this.$chatInput.get(0).scrollHeight;
        newHeight = scrollHeight + 2;

        if (newHeight > maxHeight) newHeight = maxHeight;
        if (newHeight > height) {
            this.$chatInput.css('height', newHeight);
            newPadding = newHeight + 21;
            paddingDelta = newPadding - parseInt(this.$messageList.css('paddingBottom'), 10);
            if (!!paddingDelta) {
                this.$messageList.css('paddingBottom', newPadding);
            }
        }
    }, 300)
});
