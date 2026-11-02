/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-packages-to-apps',
      comment: 'packages/ must not depend on apps/',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' }
    }
  ],
  options: {
    doNotFollow: {
      path: 'node_modules'
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json'
    }
  }
};
