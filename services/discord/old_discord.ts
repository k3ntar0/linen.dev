import request from 'superagent';
import {
  Author,
  DiscordMessage,
  DiscordThreads,
} from '../../types/discordResponses/discordMessagesInterface';
import { prisma } from '../../client';
import { channels, slackThreads, users } from '@prisma/client';
import {
  createUser,
  // findOrCreateChannel,
  updateNextPageCursor,
} from '../../lib/models';
import { createSlug } from '../../lib/util';
import { SyncStatus, updateAndNotifySyncStatus } from '../syncStatus';
import { generateRandomWordSlug } from '../../utilities/randomWordSlugs';
import { retryPromise } from '../../utilities/retryPromises';
import { listChannelsAndPersist } from './channels';
import { buildUserAvatar } from './users';

async function discordSync({
  accountId,
  fullSync = false,
}: {
  accountId: string;
  fullSync?: boolean;
}) {
  console.log('fullSync', fullSync);

  console.log({ accountId });
  const account = await prisma.accounts.findUnique({
    where: {
      id: accountId,
    },
    include: {
      discordAuthorizations: {
        orderBy: {
          createdAt: 'desc',
        },
      },
      channels: true,
    },
  });

  if (!account || !account.discordServerId) {
    return {
      status: 404,
      body: { error: 'Account not found' },
    };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    return {
      status: 500,
      body: { error: 'No discord token set' },
    };
  }

  await updateAndNotifySyncStatus(account.id, SyncStatus.IN_PROGRESS);

  try {
    await sync({
      serverId: account.discordServerId,
      accountId: account.id,
      token,
      fullSync,
    });
  } catch (error) {
    await updateAndNotifySyncStatus(account.id, SyncStatus.ERROR);
    throw error;
  }

  await updateAndNotifySyncStatus(account.id, SyncStatus.DONE);

  return {
    status: 200,
    body: {},
  };
}

async function getAuthorsFromDatabase(accountId: string) {
  const users = await prisma.users.findMany({
    where: { accountsId: accountId },
  });
  let authors: Record<string, users> = {};
  for (const user of users) {
    authors[user.externalUserId] = user;
  }
  return authors;
}

// Really similar to the Slack Sync function probably should refactor and add tests
async function sync({
  serverId,
  accountId,
  token,
  fullSync = false,
}: {
  serverId: string;
  accountId: string;
  token: string;
  fullSync?: boolean;
}) {
  const savedChannels = await listChannelsAndPersist({
    serverId,
    accountId,
    token,
  });

  let authors = await getAuthorsFromDatabase(accountId);

  console.log('savedChannels', savedChannels.length);
  for (const channel of savedChannels) {
    // Threads are ordered by archive_timestamp, in descending order.
    await listPublicArchivedThreadsAndPersist({
      channel,
      token,
      fullSync,
    });
    // we need to query our db to get all threads, not only the synchronized ones
    const threadsOnChannel = await prisma.slackThreads.findMany({
      select: { id: true },
      where: {
        channelId: channel.id,
      },
    });
    console.log(channel.channelName, 'threads', threadsOnChannel.length);
    // threads works as channels, we need to get their messages
    // replies are just attributes that references another message, need to do some crazy stuff here
    // singles are singles, could potentially be a "thread" of some other message references to it
    for (const thread of threadsOnChannel) {
      // when list message, it comes with the author
      // "type": 7 are just joins
      await listMessagesFromThreadAndPersist({
        thread,
        token,
        authors,
        accountId,
        fullSync,
      });
    }
  }
  console.log({ message: 'success' });
  return {};
}

async function listMessagesFromThreadAndPersist({
  thread,
  token,
  authors,
  accountId,
  fullSync,
}: {
  thread: Partial<slackThreads>;
  token: string;
  authors: any;
  accountId: string;
  fullSync?: boolean;
}) {
  const threadInDb = await prisma.slackThreads.findUnique({
    where: { id: thread.id },
    include: { messages: { take: 1, orderBy: { sentAt: 'desc' } } },
  });
  if (!threadInDb) return;

  // get messages has no attribute called has_more, we just need to query until is less than 50 or a specific limit
  // the messages is return in latest order, so we need to request with the oldest id as "before" parameter
  // at least for the initial sync
  let hasMore = true;
  let newestMessageId = threadInDb.messages.length
    ? threadInDb.messages.shift()?.slackMessageId
    : threadInDb.slackThreadTs;
  if (fullSync) {
    newestMessageId = undefined;
  }
  while (hasMore) {
    hasMore = false;
    const response = await getDiscordThreadMessages(
      threadInDb.slackThreadTs,
      token,
      newestMessageId
    );
    hasMore = response?.length === 50;
    if (response?.length) {
      await persistMessages({
        messages: response,
        authors,
        accountId,
        threadInDb,
      });
      hasMore && (newestMessageId = getLatestMessagesId(response));
    }
  }
}

/** be aware that this function updates the authors object */
async function findAuthorsAndPersist(
  messages: DiscordMessage[],
  authors: Record<string, users>,
  accountId: string
) {
  let usersInMessages: Record<string, Author> = {};
  let usersFounded: string[] = [];

  messages.forEach((message) => {
    usersInMessages[message.author.id] = message.author;
    usersFounded.push(message.author.id);
    if (message?.mentions) {
      for (const mention of message.mentions) {
        usersInMessages[mention.id] = mention;
        usersFounded.push(mention.id);
      }
    }
    if (message?.referenced_message) {
      usersInMessages[message.referenced_message.author.id] =
        message.referenced_message.author;
      usersFounded.push(message.referenced_message.author.id);
      if (message.referenced_message.mentions) {
        for (const mention of message.referenced_message.mentions) {
          usersInMessages[mention.id] = mention;
          usersFounded.push(mention.id);
        }
      }
    }
  });

  // find uniques usersInMessages
  for (const userId of usersFounded) {
    if (!authors[userId]) {
      // new user, insert
      const newUser = usersInMessages[userId];
      authors[userId] = await createUser({
        externalUserId: userId,
        accountsId: accountId,
        displayName: newUser.username,
        anonymousAlias: generateRandomWordSlug(),
        isAdmin: false, // TODO
        isBot: newUser?.bot || false,
        ...(newUser.avatar && {
          profileImageUrl: buildUserAvatar({
            userId: newUser.id,
            avatarId: newUser.avatar,
          }),
        }),
      });
    }
    // if exists already, lets look for the avatar
    else if (
      authors[userId] &&
      !authors[userId].profileImageUrl &&
      !!usersInMessages[userId].avatar
    ) {
      // update avatar
      await prisma.users.update({
        data: {
          profileImageUrl: buildUserAvatar({
            userId,
            avatarId: usersInMessages[userId].avatar as string,
          }),
        },
        where: { id: authors[userId].id },
      });
    }
  }
}

async function cleanUpMessage(slackMessageId: string, channelId: string) {
  // https://discord.com/developers/docs/resources/channel#message-types-thread-starter-message
  // These are the first message in a public thread. They point back to the message in the parent channel from which the thread was started (type 21)
  // These messages will never have content, embeds, or attachments, mainly just the message_reference and referenced_message fields.
  // we should remove the wrong message starter
  const message = await prisma.messages.findUnique({
    where: {
      channelId_slackMessageId: {
        channelId,
        slackMessageId,
      },
    },
    include: { mentions: true },
  });
  if (message) {
    for (const mention of message.mentions) {
      await prisma.mentions
        .delete({
          where: {
            messagesId_usersId: {
              messagesId: mention.messagesId,
              usersId: mention.usersId,
            },
          },
        })
        .catch(console.error);
    }
    await prisma.messages
      .delete({ where: { id: message.id } })
      .catch(console.error);
  }
}

async function persistMessages({
  messages,
  authors,
  accountId,
  threadInDb,
}: {
  messages: DiscordMessage[];
  authors: any;
  accountId: string;
  threadInDb: slackThreads;
}) {
  // first we need to insert the users to have the userId available
  await findAuthorsAndPersist(messages, authors, accountId);

  // each message has the author
  // has mentions and reactions, but not sure if we should tackle this now
  // lets keep simple, just authors
  console.log('messages', messages?.length);
  const cleanUpMessages: any[] = [];
  const transaction = messages.map((message) => {
    let _message = message;
    if (message.referenced_message && message.referenced_message.content) {
      if (message.type === 21) {
        cleanUpMessages.push(cleanUpMessage(message.id, threadInDb.channelId));
      }
      _message = message.referenced_message;
    }
    let body = _message.content;
    let author = authors[_message.author.id];
    let mentions = _message.mentions?.map((mention) => ({
      usersId: authors[mention.id].id,
    }));
    let slackMessageId = _message.id;
    return prisma.messages.upsert({
      where: {
        channelId_slackMessageId: {
          channelId: threadInDb.channelId,
          slackMessageId,
        },
      },
      update: {
        slackMessageId,
        slackThreadId: threadInDb.id,
        usersId: author.id,
        body,
        ...(mentions?.length && {
          mentions: {
            createMany: {
              skipDuplicates: true,
              data: mentions,
            },
          },
        }),
      },
      create: {
        body,
        sentAt: new Date(_message.timestamp),
        channelId: threadInDb.channelId,
        slackMessageId,
        slackThreadId: threadInDb.id,
        usersId: author.id,
        ...(mentions?.length && {
          mentions: {
            createMany: {
              skipDuplicates: true,
              data: mentions,
            },
          },
        }),
      },
    });
  });
  transaction && (await prisma.$transaction(transaction));
  await Promise.allSettled(cleanUpMessages);
}

async function persistThreads(threads: DiscordThreads[], channelId: string) {
  //Save discord threads
  const threadsTransaction: any = threads
    .map((thread: DiscordThreads) => {
      if (!thread.id) {
        return null;
      }
      return prisma.slackThreads.upsert({
        where: {
          slackThreadTs: thread.id,
        },
        update: { messageCount: thread.message_count + 1 },
        create: {
          slackThreadTs: thread.id,
          channelId,
          messageCount: thread.message_count + 1,
          slug: createSlug(thread.name),
        },
      });
    })
    .filter(Boolean);

  return await prisma.$transaction(threadsTransaction);
}

/**
  List Public Archived Threads GET/channels/{channel.id}/threads/archived/public
  Requires the READ_MESSAGE_HISTORY permission.
 */
async function listPublicArchivedThreadsAndPersist({
  channel,
  token,
  fullSync,
}: {
  channel: channels;
  token: string;
  fullSync?: boolean;
}) {
  const timestampCursorFlag = new Date().toISOString();
  let hasMore = true;
  const threads: DiscordThreads[] = [];
  let timestamp;
  while (hasMore) {
    const response = await getAllArchivedThreads(
      channel.externalChannelId,
      timestamp,
      token
    );
    hasMore = response.hasMore;
    if (response.threads && response.threads.length) {
      threads.push(...response.threads);
      await persistThreads(response.threads, channel.id);
      hasMore && (timestamp = getShorterTimeStamp(response.threads));
    }
    if (!fullSync) {
      // only skip if isn't full sync)
      if (
        channel.slackNextPageCursor &&
        timestamp &&
        new Date(channel.slackNextPageCursor) > new Date(timestamp)
      ) {
        // already reach our last cursor
        console.log('already reach our last cursor');
        break;
      }
    }
  }
  // getting here means that the sync for this channels was completed
  // so our next run should get data from Date.now until cursor timestamp
  await updateNextPageCursor(channel.id, timestampCursorFlag);
  console.log('threads', threads.length);
  return threads;
}

//creates an array and pushes the content of the replies onto it
// async function getReplies(channelId: string, token: string) {
//   const messages = await getDiscord(`/channels/${channelId}/messages`, token);
//   const replies = messages.body
//     .filter(
//       (message: DiscordMessage) =>
//         message.message_reference && message.type === 0
//     )
//     .reverse();

//   const roots = messages.body.filter(
//     (m: DiscordMessage) => !m.message_reference && m.type === 0
//   );

//   // Discord returns each message with the parent message it is referencing
//   // Ideally we have messages and all the child messages that is replying to it
//   // what we ended up doing is reversing the relation with a dictionary
//   // Then went through and used breadth first search traversal to create the threads
//   let dict: { [index: string]: DiscordMessage[] } = {};

//   replies.forEach((ele: DiscordMessage) => {
//     if (ele.referenced_message) {
//       if (!dict[ele.referenced_message.id]) {
//         dict[ele.referenced_message.id] = [];
//       }
//       dict[ele.referenced_message.id].push(ele);
//     }
//   });

//   const threads = roots.map((root: DiscordMessage) => {
//     let queue: DiscordMessage[] = [root];
//     let result: DiscordMessage[] = [];
//     while (queue.length > 0) {
//       const message = queue.shift();
//       if (!message) {
//         return;
//       }

//       result.push(message);

//       if (dict[message.id]) {
//         queue.push(...dict[message.id]);
//       }
//     }
//     return result;
//   });

//   return threads;
// }

// async function saveDiscordThreads(
//   threads: Prisma.slackThreadsUncheckedCreateInput
// ) {
//   return prisma.slackThreads.upsert({
//     where: { slackThreadTs: threads.slackThreadTs },
//     update: {},
//     create: threads,
//   });
// }

// async function saveDiscordChannels(channel: Prisma.channelsCreateInput) {
//   return prisma.channels.upsert({
//     where: {
//       externalChannelId: channel.externalChannelId,
//     },
//     update: {},
//     create: channel,
//   });
// }

async function getDiscord(path: string, token: string, query: any = {}) {
  // console.log({ token });
  // const token = process.env.DISCORD_TOKEN;

  const url = 'https://discord.com/api';

  const response = await request
    .get(url + path)
    .query(query)
    .set('Authorization', 'Bot ' + token);
  return response;
}

// async function getUsers(serverId: string, token: string) {
//   const response = await getDiscord(`/guilds/${serverId}/members`, token);
//   return response.body;
// }

// async function getAllActiveThreads(serverId: string, token: string) {
//   let result = [];
//   // Given a server id - gets all the active threads in that server
//   try {
//     const activeThreads = (
//       await getDiscord(`/guilds/${serverId}/threads/active`, token)
//     ).body as GuildActiveThreads;

//     const threadIds =
//       activeThreads.threads?.map((thread: DiscordThreads) => {
//         return thread.id;
//       }) || [];

//     for (const i in threadIds) {
//       const id = threadIds[i];
//       const message = await getDiscordThreadMessages(id, token);
//       result.push(message);
//     }

//     console.log('Successfully reloaded application (/) commands.');
//   } catch (error) {
//     console.error(4, String(error));
//   }
//   return result;
// }

async function getAllArchivedThreads(
  channelId: string,
  beforeCursor: string | undefined,
  token: string
): Promise<{ threads: DiscordThreads[]; hasMore: boolean }> {
  const response = await retryPromise({
    promise: getDiscord(
      `/channels/${channelId}/threads/archived/public`,
      token,
      {
        before: beforeCursor,
        ...(!beforeCursor && { limit: 2 }),
      }
    ),
  })
    .then((e) => e?.body)
    .catch(() => {
      return { has_more: false, threads: [] };
    });

  const hasMore = response?.has_more;
  const threads = response?.threads as DiscordThreads[];

  return {
    threads,
    hasMore,
  };
}

async function getDiscordThreadMessages(
  threadId: string,
  token: string,
  newestMessageId?: string
): Promise<DiscordMessage[]> {
  const response = await retryPromise({
    promise: getDiscord(`/channels/${threadId}/messages`, token, {
      after: newestMessageId,
    }),
  }).catch(() => {
    return { body: [] };
  });
  const messages = response.body;
  return messages;
}

//TODOS:
// create a new account
// Render the client side with new account

function getShorterTimeStamp(threads: DiscordThreads[]): string | undefined {
  if (!threads || !threads.length) return;
  const sortedThread = threads
    ?.map((t) => new Date(t.thread_metadata.archive_timestamp))
    .sort((a: Date, b: Date) => a.getTime() - b.getTime())
    .shift();
  return sortedThread && sortedThread.toISOString();
}

function getLatestMessagesId(messages: DiscordMessage[]): string | undefined {
  if (!messages || !messages.length) return;
  const sortedThread = messages
    .sort(
      (a: DiscordMessage, b: DiscordMessage) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )
    .pop();
  return sortedThread && sortedThread.id;
}
