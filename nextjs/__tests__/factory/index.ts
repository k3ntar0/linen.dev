import createMessage from './message';
import createThread from './thread';
import createResponse from './response';
import createRequest from './request';
import createAccount from './account';
import createAuth from './auth';
import createPermissions from './permissions';
import createChannel from './channel';

export function create(name: string, options?: object): any {
  switch (name) {
    case 'request':
      return createRequest(options);
    case 'response':
      return createResponse(options);
    case 'thread':
      return createThread(options);
    case 'message':
      return createMessage(options);
    case 'account':
      return createAccount(options);
    case 'auth':
      return createAuth(options);
    case 'permissions':
      return createPermissions(options);
    case 'channel':
      return createChannel(options);
    default:
      throw new Error(`Unknown factory name: ${name}`);
  }
}
