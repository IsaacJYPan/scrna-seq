'use strict';

const publisherName = String(process.env.WINDOWS_PUBLISHER_NAME || '').trim();
const defaultServerUrl = String(process.env.TRACEOMICS_DESKTOP_URL || '').trim();

module.exports = {
  appId: 'org.traceomics.workbench',
  productName: 'TraceOmics',
  copyright: `Copyright © ${new Date().getFullYear()} TraceOmics`,
  artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
  forceCodeSigning: true,
  ...(defaultServerUrl ? {
    extraMetadata: { traceomicsDesktop: { defaultServerUrl } },
  } : {}),
  asar: true,
  directories: {
    output: 'release/desktop',
  },
  files: [
    'dist/**/*',
    'desktop/**/*',
    'package.json',
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.svg',
    requestedExecutionLevel: 'asInvoker',
    verifyUpdateCodeSignature: true,
    ...(publisherName ? { publisherName: [publisherName] } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'TraceOmics',
    uninstallDisplayName: 'TraceOmics',
  },
};
