/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { expect } from 'chai';
import { Connection } from '@salesforce/core';
import sinon = require('sinon');
import { OrgUtils } from '../../src/utils/orgUtils';
import { OrgPreferences } from '../../src/utils/orgPreferences';
import { QueryTools } from '../../src/utils/query';
import { Logger } from '../../src/utils/logger';

// W-24296247: orgs with Vlocity Insurance (vlocity_ins) plus the Insurance Industries Extension (vlocity_ins_fsc)
// used to prompt for both namespaces, but only vlocity_ins contains OmniStudio components
describe('OrgUtils - package selection', () => {
  let sandbox: sinon.SinonSandbox;
  let connection: Connection;
  let toolingQueryStub: sinon.SinonStub;
  let logStub: sinon.SinonStub;

  const pkg = (NamespacePrefix: string, MajorVersion = 890, MinorVersion = 1): any => ({
    NamespacePrefix,
    MajorVersion,
    MinorVersion,
    Name: 'Salesforce',
  });
  const entityDefinitions = (...names: string[]): any => ({
    totalSize: names.length,
    records: names.map((QualifiedApiName) => ({ QualifiedApiName })),
  });
  const filter = (packages: any[]): Promise<any[]> =>
    (OrgUtils as any).filterPackagesWithOmniStudioComponents(connection, packages);

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    toolingQueryStub = sandbox.stub();
    connection = { tooling: { query: toolingQueryStub } } as unknown as Connection;
    logStub = sandbox.stub(Logger, 'log');
    sandbox.stub(Logger, 'logVerbose');
    sandbox.stub(Logger, 'warn');
  });

  afterEach(() => sandbox.restore());

  describe('filterPackagesWithOmniStudioComponents', () => {
    it('drops extension packages that do not contain OmniStudio components', async () => {
      toolingQueryStub.resolves(entityDefinitions('vlocity_ins__OmniScript__c'));

      const result = await filter([pkg('vlocity_ins'), pkg('vlocity_ins_fsc', 891, 125)]);

      expect(result.map((p) => p.NamespacePrefix)).to.deep.equal(['vlocity_ins']);
      const query: string = toolingQueryStub.getCall(0).args[0];
      expect(query).to.include('FROM EntityDefinition');
      expect(query).to.include("'vlocity_ins__OmniScript__c'");
      expect(query).to.include("'vlocity_ins_fsc__OmniScript__c'");
      expect(logStub.calledWithMatch('vlocity_ins_fsc')).to.be.true;
    });

    it('keeps every package that contains OmniStudio components, matching names case-insensitively', async () => {
      toolingQueryStub.resolves(entityDefinitions('vlocity_cmt__OmniScript__c', 'VLOCITY_INS__OMNISCRIPT__C'));

      const result = await filter([pkg('vlocity_cmt'), pkg('vlocity_ins')]);

      expect(result.map((p) => p.NamespacePrefix)).to.deep.equal(['vlocity_cmt', 'vlocity_ins']);
    });

    it('always keeps the Foundation package, which has no custom OmniStudio objects', async () => {
      toolingQueryStub.resolves(entityDefinitions('vlocity_ins__OmniScript__c'));

      const result = await filter([pkg('omnistudio'), pkg('vlocity_ins'), pkg('vlocity_ins_fsc')]);

      expect(result.map((p) => p.NamespacePrefix)).to.deep.equal(['omnistudio', 'vlocity_ins']);
      expect(toolingQueryStub.getCall(0).args[0]).to.not.include('omnistudio__OmniScript__c');
    });

    it('does not query when only the Foundation package needs checking', async () => {
      const packages = [pkg('omnistudio')];

      const result = await filter(packages);

      expect(result).to.equal(packages);
      expect(toolingQueryStub.called).to.be.false;
    });

    it('falls back to all packages when none of them contain OmniStudio components', async () => {
      toolingQueryStub.resolves(entityDefinitions());
      const packages = [pkg('vlocity_ins'), pkg('vlocity_ins_fsc')];

      const result = await filter(packages);

      expect(result).to.equal(packages);
    });

    it('falls back to all packages when the check fails', async () => {
      toolingQueryStub.rejects(new Error('Tooling API unavailable'));
      const packages = [pkg('vlocity_ins'), pkg('vlocity_ins_fsc')];

      const result = await filter(packages);

      expect(result).to.equal(packages);
    });
  });

  describe('getOrgDetails', () => {
    let promptStub: sinon.SinonStub;

    beforeEach(() => {
      promptStub = sandbox.stub(Logger, 'prompt');
      sandbox.stub(OrgUtils, 'isOmniStudioOrgPermissionEnabled').resolves(false);
      sandbox.stub(OrgUtils, 'isOmnistudioMetadataAPIEnabled').resolves(false);
      sandbox.stub(OrgPreferences, 'isFoundationPackage').resolves(false);
    });

    const stubInstalledPackages = (packages: any[]): void => {
      const queryAllStub = sandbox.stub(QueryTools, 'queryAll');
      queryAllStub.withArgs(connection, '', 'Publisher', sinon.match.any).resolves(packages);
      queryAllStub.withArgs(connection, '', 'Organization', sinon.match.any).resolves([{ Name: 'Org', Id: '00D' }]);
    };

    it('selects the only package with OmniStudio components without prompting', async () => {
      stubInstalledPackages([pkg('vlocity_ins', 890, 491), pkg('vlocity_ins_fsc', 891, 125), pkg('SIM', 0, 0)]);
      toolingQueryStub.resolves(entityDefinitions('vlocity_ins__OmniScript__c'));
      // Fail fast instead of looping forever on an invalid selection if the package isn't filtered out
      promptStub.rejects(new Error('Unexpected package selection prompt'));

      const result = await OrgUtils.getOrgDetails(connection);

      expect(promptStub.called).to.be.false;
      expect(result.packageDetails).to.deep.equal({ namespace: 'vlocity_ins', version: '890.491' });
    });

    it('still prompts when more than one package contains OmniStudio components', async () => {
      stubInstalledPackages([pkg('vlocity_ins', 890, 491), pkg('vlocity_cmt', 890, 100)]);
      toolingQueryStub.resolves(entityDefinitions('vlocity_ins__OmniScript__c', 'vlocity_cmt__OmniScript__c'));
      promptStub.resolves('2');

      const result = await OrgUtils.getOrgDetails(connection);

      expect(promptStub.calledOnce).to.be.true;
      // packages are listed alphabetically: 1. vlocity_cmt, 2. vlocity_ins
      expect(result.packageDetails.namespace).to.equal('vlocity_ins');
    });
  });
});
