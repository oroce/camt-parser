const fs = require('fs');
const xml = fs.readFileSync(process.argv[2]).toString().trim();
const cheerio = require('cheerio');
const xpath = require('xpath');
const select = xpath.useNamespaces({
  'ele': 'http://www.cardinal.hu/electra',
  'x': 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.02'
});
const dom = require('xmldom').DOMParser;
const doc = new dom().parseFromString(xml)

const messages = select('//x:BkToCstmrStmt', doc)
  .map(parseMessage);

function parseMessage(messageNode) {
  const grpHdrNode = select('./x:GrpHdr', messageNode, true);
  const grpHdr = {
    msgId: select('./x:MsgId', grpHdrNode, true).textContent,
    createdAt: select('./x:CreDtTm', grpHdrNode, true).textContent,
    additionalInfo: tryProp(select('./x:AddtlInf', grpHdrNode, true), 'textContent')
  };
  const recipientNode = select('./x:MsgRcpt', grpHdrNode, true);
  if (recipientNode) {
    grpHdr.recipient = {
      name: tryProp(select('./Nm', recipientNode, true), 'textContent'),
      postalAddress: tryProp(select('./x:PstlAdr', recipientNode, true), 'textContent'),
      identification: tryProp(select('./Id', recipientNode, true), 'textContent'),
      countryOfResidence: tryProp(select('./CtryOfRes', recipientNode, true), 'textContent'),
      contactDetails: tryProp(select('./CtctDtls', recipientNode, true), 'textContent')
    };
  }

  // parse pagination

  const statements = select('./x:Stmt', messageNode).map(parseStatement);
  return {
    //grpHdrNode: grpHdrNode,
    grpHdr: grpHdr,
    statements: statements
  };
}

function parseStatement(statementNode) {

  const transactions = select('./x:Ntry', statementNode).map(parseTransaction);
  return {
    id: tryProp(select('./x:Id', statementNode, true), 'textContent'),
    seqNum: tryProp(select('./x:ElctrncSeqNb', statementNode, true), 'textContent'),
    createdAt: tryProp(select('./x:CreDtTm', statementNode, true), 'textContent'),
    localAccount: tryProp(select('./x:Acct/x:Id', statementNode, true), 'textContent', '').trim(),
    localCurrency: tryProp(select('./x:Acct/x:Ccy', statementNode, true), 'textContent') || tryAttr(select('./x:Bal/x:Amt', statementNode, true), 'Ccy'),
    date: tryProp(select('./x:Ntry[1]/x:ValDt/x:Dt | ./x:Ntry[1]/x:ValDt/x:DtTm', statementNode, true), 'textContent'),
    startBalance: getStartBalance(statementNode),
    endBalance: getEndBalance(statementNode),

    transactions: transactions
  };
}

function parseTransaction(transactionNode) {
  const transactionDetails = select('.//x:NtryDtls//x:TxDtls', transactionNode).map(parseTransactionDetail);
  return {
    executionDate: select('./x:BookgDt/x:Dt | ./x:BookgDt/x:DtTm', transactionNode, true).textContent,
    effectiveDate: select('./x:ValDt/x:Dt | ./x:ValDt/x:DtTm', transactionNode, true).textContent,
    transferType: getTransferType(select('./x:BkTxCd/x:Prtry', transactionNode, true)),
    transferredAmount: formatAmount(transactionNode),
    transactionDetails: transactionDetails,
    purpose: tryProp(select('./x:AddtlNtryInf', transactionNode, true), 'textContent') || transactionDetails.map(function(detail) {
      return detail.references;
    }).join(' ')
  };
}

function parseTransactionDetail(transactionDetailNode) {
  const transactionDetail = {};
  const unstructured = select('./x:RmtInf/x:Ustrd', transactionDetailNode);
  if (unstructured.length) {
    transactionDetail.messages = unstructured.map(function(node) {
      return node.textContent.trim().replace(/\s{2,}/gm, ' ');
    }).join('');
  }
  const structured = select('./x:RmtInf/x:Strd/x:CdtrRefInf/x:Ref | ./x:Refs/x:EndToEndId', transactionDetailNode);
  if (structured.length) {
    transactionDetail.references = structured.map(function(node) {
      return node.textContent.trim();
    }).join('');
  }
  const mandateId = tryProp(select('./x:Refs/x:MndtId', transactionDetailNode, true), 'textContent');
  if (mandateId) {
    transactionDetail.mandateId = mandateId;
  }
  const reason = tryProp(select('./x:RtrInf/x:Rsn/x:Cd', transactionDetailNode, true), 'textContent');
  if (reason) {
    transactionDetail.reason = {
      code: reason,
      description: '<not set yet>'
    };
  }
  transactionDetail.party = getParty(transactionDetailNode);
  return transactionDetail;
}
function getStartBalance(node) {
  const startNode = ['OPBD', 'PRCD', 'ITBD']
    .map(getBalanceNode(node))
    .filter(function (value) {
      return value != null;
    })[0]
  if (!startNode) {
    return null;
  }

  return formatAmount(startNode); // startNode
}
function getEndBalance(node) {
  const endNode = ['CLBD', 'ITBD', 'CLAV']
    .map(getBalanceNode(node))
    .filter(function (value) {
      return value != null;
    })[0];

  if (!endNode) {
    return null;
  }

  return formatAmount(endNode);
}
function getBalanceNode(node) {
  return function (code) {
    return select(`./x:Bal/x:Tp/x:CdOrPrtry/x:Cd[text()='${code}']/../../..`, node, true);
  };
}
function getTransferType(node) {
  if (!node) {
    return;
  }

  return  {
    proprietaryCode: select('./x:Cd', node, true).textContent,
    proprietaryIssuer: tryProp(select('./x:Issr', node, true), 'textContent')
  };
}
function formatAmount(node) {
  const sign = select('./x:CdtDbtInd', node, true).textContent === 'DBIT' ? -1 : 1;
  const currency = select('./x:Amt', node, true).getAttribute('Ccy');
  const value = sign * select('./x:Amt', node, true).textContent
  return {
    currency: currency,
    value: value
  };
}
function getParty(node) {
  const values = {};
  const type = select('../../x:CdtDbtInd', node, true).textContent === 'CRDT' ? 'Dbtr' : 'Cdtr';
  const partyNode = select(`./x:RltdPties/x:${type}`, node, true);
  const accountNode = select(`./x:RltdPties/x:${type}Acct/x:Id`, node, true);
  const bicNode = select(`./x:RltdPties/x${type}Agt/x:FinInstnId/x:BIC`, node, true);
  if (partyNode) {
    values.remoteOwner = tryProp(select('./x:Nm', partyNode, true), 'textContent');
    values.remoteOwnerCountry = tryProp(select('./x:PstlAdr/Ctry', partyNode, true), 'textContent');
    values.remoteOwnerAddress = tryProp(select('./x:PstlAdr/x:AdrLine', partyNode, true), 'textContent');
  }
  if (accountNode) {
    values.remoteAccount = tryProp(select('./x:IBAN', accountNode, true), 'textContent') ||  tryProp(select('./x:Othr/x:Id', accountNode, true), 'textContent');
    values.remoteBankBIC = tryProp(bicNode, 'textContent');
  }
  return values;
}
function tryProp(node, prop, defaultValue) {
  if (!node) {
    return defaultValue;
  }
  return node[prop];
}
function tryAttr(node, attr, defaultValue) {
  if (!node) {
    return defaultValue;
  }
  return node.getAttribute(attr);
}

console.log('messages=', JSON.stringify(messages, null, 2));
