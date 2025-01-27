import React from 'react';
import Link from 'next/link';
import SearchBar from 'components/search/SearchBar';
import JoinButton from 'components/JoinButton';
import { addHttpsToUrl } from 'utilities/url';
import { pickTextColorBasedOnBgColor } from 'utilities/colors';
import { Permissions } from 'types/shared';
import { Settings } from 'serializers/account/settings';
import type { ChannelSerialized } from 'lib/channel';

interface Props {
  settings: Settings;
  channels: ChannelSerialized[];
  isSubDomainRouting: boolean;
  permissions: Permissions;
  communityInviteUrl?: string;
  communityUrl?: string;
}

function isWhiteColor(color: string) {
  return ['white', '#fff', '#ffffff'].includes(color.toLowerCase());
}

export default function Header({
  settings,
  channels,
  isSubDomainRouting,
  communityInviteUrl,
  communityUrl,
  permissions,
}: Props) {
  const { brandColor, communityName } = settings;
  const homeUrl = addHttpsToUrl(settings.homeUrl);
  const docsUrl = addHttpsToUrl(settings.docsUrl);
  const logoUrl = addHttpsToUrl(settings.logoUrl);
  const fontColor = pickTextColorBasedOnBgColor(brandColor, 'white', 'black');
  const borderColor = isWhiteColor(brandColor) ? '#e5e7eb' : brandColor;
  return (
    <div
      className="flex h-16 px-4 py-2 items-center"
      style={{
        backgroundColor: brandColor,
        borderBottom: `1px solid ${borderColor}`,
        borderTop: `1px solid ${brandColor}`,
        gap: '24px',
      }}
    >
      <Link href={homeUrl || '/'} passHref>
        <a className="cursor-pointer block" target="_blank">
          <img
            className="block"
            style={{ height: '32px' }}
            src={logoUrl}
            height="32"
            alt={`${homeUrl} logo`}
          />
        </a>
      </Link>
      <div
        className="flex w-full items-center"
        style={{
          justifyContent: 'flex-end',
          gap: '24px',
        }}
      >
        <div className="hidden sm:flex w-full">
          <SearchBar
            borderColor={borderColor}
            channels={channels}
            communityName={communityName}
            isSubDomainRouting={isSubDomainRouting}
            communityType={settings.communityType}
          />
        </div>
        <a
          className="hidden sm:flex items-center text-sm"
          style={{ color: fontColor, fontWeight: 500 }}
          rel="noreferrer"
          title="Documentation"
          target="_blank"
          href={docsUrl}
        >
          Docs
        </a>
        <JoinButton
          inviteUrl={communityInviteUrl || communityUrl}
          communityType={settings.communityType}
          communityId={settings.communityId}
          permissions={permissions}
        />
      </div>
    </div>
  );
}
