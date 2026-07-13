// SPDX-License-Identifier: GPL-3.0-or-later
var COMPANION_TABLES = {
  'job.status': { sheet: 'Jobs', columns: ['job_id', 'recipe', 'status', 'progress', 'updated_at'] },
  'runtime.status': { sheet: 'Runtimes', columns: ['runtime_id', 'status', 'version', 'last_seen_at'] },
  'version.register': { sheet: 'Versions', columns: ['version_id', 'shot_id', 'take', 'kind', 'file_ref', 'duration_frames', 'checksum', 'updated_at'] }
};

function doPost(e) {
  try {
    var request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var expectedToken = PropertiesService.getScriptProperties().getProperty('MOTK_COMPANION_TOKEN');
    if (!expectedToken) throw new Error('MOTK_COMPANION_TOKEN script property is not configured');
    if (!request.token || request.token !== expectedToken) throw new Error('unauthorized');
    var table = COMPANION_TABLES[request.action];
    if (!table || !request.data || typeof request.data !== 'object') throw new Error('invalid Companion action or data');
    var workbook = SpreadsheetApp.getActiveSpreadsheet();
    var target = companionTable_(workbook, table);
    var data = request.data;
    if (!data.updated_at) data.updated_at = new Date().toISOString();
    if (request.action === 'runtime.status' && !data.last_seen_at) data.last_seen_at = data.updated_at;
    var row = target.headers.map(function () { return ''; });
    table.columns.forEach(function (column) {
      row[target.headers.indexOf(column)] = data[column] === undefined ? '' : data[column];
    });
    target.sheet.appendRow(row);
    return companionJson_({ ok: true, action: request.action, sheet: table.sheet });
  } catch (error) {
    return companionJson_({ ok: false, error: String(error && error.message || error) });
  }
}

function companionTable_(workbook, table) {
  var sheet = workbook.getSheetByName(table.sheet) || workbook.insertSheet(table.sheet);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(table.columns);
    return { sheet: sheet, headers: table.columns.slice() };
  }
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var normalized = headers.map(function (value) { return String(value || '').trim(); });
  if (normalized.some(function (value) { return /^fi_[A-Za-z0-9._-]+$/i.test(value); })) {
    throw new Error('core_contract_sheet_conflict:' + table.sheet);
  }
  if (normalized.length && !table.columns.some(function (column) { return normalized.indexOf(column) !== -1; })) {
    throw new Error('companion_sheet_schema_conflict:' + table.sheet);
  }
  table.columns.forEach(function (column) {
    if (headers.indexOf(column) === -1) {
      headers.push(column);
      sheet.getRange(1, headers.length).setValue(column);
    }
  });
  return { sheet: sheet, headers: headers };
}

function companionJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
