import validator = require('validator');

import db = require('../database');
import user = require('../user');
import utils = require('../utils');
import plugins = require('../plugins');

const intFields: string[] = ['timestamp', 'edited', 'fromuid', 'roomId', 'deleted', 'system'];

interface MessagingInfo {
    newMessageCutoff: number;
    getMessagesFields: (mids: string[], fields: string[]) => Promise<Message[]>;
    getMessageField: (mid: string, field: string) => Promise<any>;
    getMessageFields: (mid: string, field: string[]) => Promise<Message | null>;
    setMessageField: (mid: string, field: string, content: any) => Promise<void>;
    setMessageFields: (mid: string, data: any) => Promise<void>;
    getMessagesData: (mids: string[], uid: string, roomId: string, isNew: boolean) => Promise<any>;
    parse: any;
}

interface User {
    uid: number;
    username: string;
    userslug: string;
    picture: string;
    status: string;
    banned: boolean;
    deleted: boolean;
}

interface Message {
    fromUser?: User; // user is in another module
    fromuid?: number;
    messageId?: number;
    self?: number;
    newSet?: boolean;
    roomId?: string;
    deleted?: boolean;
    system?: boolean;
    timestamp?: number;
    timestampISO?: string;
    edited?: number;
    editedISO?: string;
    content?: string;
    cleanedContent?: string;
    ip?: string;
}

type MessageField = number | boolean | User | string | null


async function modifyMessage(message: Message, fields: string [], mid: number): Promise<Message | null> {
    if (message) {
        db.parseIntFields(message, intFields, fields);
        if (message.timestamp !== undefined) {
            message.timestampISO = utils.toISOString(message.timestamp);
        }
        if (message.edited !== undefined) {
            message.editedISO = utils.toISOString(message.edited);
        }
    }

    const payload: any = await plugins.hooks.fire('filter:messaging.getFields', {
        mid: mid,
        message: message,
        fields: fields,
    });

    return payload.message;
}


module.exports = function (Messaging : MessagingInfo) {
    Messaging.newMessageCutoff = 1000 * 60 * 3;

    Messaging.getMessagesFields = async (mids: string[], fields: string[]) : Promise<Message[] | null> => {
        const keys: string[] = mids.map(mid => `message:${mid}`);
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const messages: Message[] = await db.getObjects(keys, fields) as Message[];
        return await Promise.all(messages.map(
            async (message: Message, idx: number) => modifyMessage(message, fields, parseInt(mids[idx], 10))
        ));
    };

    Messaging.getMessageField = async (mid: string, field: string) : Promise<MessageField> => {
        const fields = await Messaging.getMessageFields(mid, [field]);
        return fields ? fields[field] : null;
    };

    Messaging.getMessageFields = async (mid: string, fields: string[]) : Promise<Message | null> => {
        const messages: (Message[] | null) = await Messaging.getMessagesFields([mid], fields);
        return messages ? messages[0] : null;
    };

    Messaging.setMessageField = async (mid: string, field: string, content: any) : Promise<void> => {
        await db.setObjectField(`message:${mid}`, field, content);
    };

    Messaging.setMessageFields = async (mid: string, data : any) : Promise<void> => {
        await db.setObject(`message:${mid}`, data);
    };

    Messaging.getMessagesData = async (mids: string[], uid: string, roomId: string, isNew: boolean) : Promise<any> => {
        let messages: Message[] = await Messaging.getMessagesFields(mids, []);
        messages = await user.blocks.filter(uid, 'fromuid', messages);
        messages = messages
            .map((msg: Message, idx: number) => {
                if (msg) {
                    msg.messageId = parseInt(mids[idx], 10);
                    msg.ip = undefined;
                }
                return msg;
            })
            .filter(Boolean);

        const users : User[] = await user.getUsersFields(
            messages.map(msg => msg && msg.fromuid),
            ['uid', 'username', 'userslug', 'picture', 'status', 'banned']
        );

        messages.forEach((message: Message, index: number) => {
            message.fromUser = users[index];
            message.fromUser.banned = !!message.fromUser.banned;
            message.fromUser.deleted = message.fromuid !== message.fromUser.uid && message.fromUser.uid === 0;

            const self = message.fromuid === parseInt(uid, 10);
            message.self = self ? 1 : 0;

            message.newSet = false;
            message.roomId = String(message.roomId || roomId);
            message.deleted = !!message.deleted;
            message.system = !!message.system;
        });

        messages = await Promise.all(messages.map(async (message) => {
            if (message.system) {
                message.content = validator.escape(String(message.content));
                message.cleanedContent = utils.stripHTMLTags(utils.decodeHTMLEntities(message.content));
                return message;
            }

            const result = await Messaging.parse(message.content, message.fromuid, uid, roomId, isNew);
            message.content = result;
            message.cleanedContent = utils.stripHTMLTags(utils.decodeHTMLEntities(result));
            return message;
        }));

        if (messages.length > 1) {
            // Add a spacer in between messages with time gaps between them
            messages = messages.map((message, index) => {
                // Compare timestamps with the previous message, and check if a spacer needs to be added
                if (index > 0 && message.timestamp > messages[index - 1].timestamp + Messaging.newMessageCutoff) {
                    // If it's been 5 minutes, this is a new set of messages
                    message.newSet = true;
                } else if (index > 0 && message.fromuid !== messages[index - 1].fromuid) {
                    // If the previous message was from the other person, this is also a new set
                    message.newSet = true;
                } else if (index === 0) {
                    message.newSet = true;
                }

                return message;
            });
        } else if (messages.length === 1) {
            // For single messages, we don't know the context, so look up the previous message and compare
            const key: string = `uid:${uid}:chat:room:${roomId}:mids`;
            const index = await db.sortedSetRank(key, messages[0].messageId);
            if (index > 0) {
                const mid = await db.getSortedSetRange(key, index - 1, index - 1);
                const fields = await Messaging.getMessageFields(mid, ['fromuid', 'timestamp']);
                if ((messages[0].timestamp > fields.timestamp + Messaging.newMessageCutoff) ||
                    (messages[0].fromuid !== fields.fromuid)) {
                    // If it's been 5 minutes, this is a new set of messages
                    messages[0].newSet = true;
                }
            } else {
                messages[0].newSet = true;
            }
        } else {
            messages = [];
        }

        const data = await plugins.hooks.fire('filter:messaging.getMessages', {
            messages: messages,
            uid: uid,
            roomId: roomId,
            isNew: isNew,
            mids: mids,
        });

        return data && data.messages;
    };
};

