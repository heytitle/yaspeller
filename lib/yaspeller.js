'use strict';

const async = require('async');
const entities = require('entities');
const fs = require('fs');
const eyo = require('./eyo');
const formatModule = require('./format');
const ignore = require('./ignore');
const isutf8 = require('isutf8');
const request = require('request');
const pth = require('path');
const MarkdownIt = require('markdown-it');
const xml2js = require('xml2js');
const yaspellerApi = require('yandex-speller');
const md = new MarkdownIt();
const printDebug = require('../lib/debug').print;
const MAX_LEN_TEXT = 10000; // Max length of text for Yandex.Speller API
const TOO_MANY_ERRORS = 4;

function getMaxRequest(settings) {
    return settings.maxRequest || 2;
}

function stripTags(html) {
    return html.replace(/<\/?[a-z][^>]*>/gi, ' ');
}

/**
 * Check text for typos.
 *
 * @param {string} originalText
 * @param {Function} callback
 * @tutorial settings
 * @param {Object} [settings]
 * @param {string} [settings.format] Text format: plain or html.
 * @param {string|Array} [settings.lang] Language: en, ru or uk.
 * @param {Array<RegExp>} [settings.ignoreText]
 * @param {Object} [settings.options]
 */
function checkText(originalText, callback, settings) {
    let text = originalText;

    const apiSettings = Object.assign({}, settings);
    const format = formatModule.getFormat(text, apiSettings);
    const lang = apiSettings.lang || 'en,ru';

    apiSettings.lang = Array.isArray(lang) ? lang.join(',') : lang;

    Array.isArray(apiSettings.ignoreText) && apiSettings.ignoreText.forEach(function(re) {
        text = text.replace(re, '');
    });

    if (ignore.hasIgnoredText(text)) {
        text = ignore.lines(text);
        text = ignore.blocks(text);
    }

    if (format === 'html' || format === 'markdown') {
        if (format === 'markdown') {
            text = md.render(text);
        }

        if (apiSettings.ignoreTags) {
            text = ignore.tags(text, apiSettings.ignoreTags);
        }

        text = ignore.comments(text);
        text = stripTags(text);
        text = entities.decodeHTML(text);
    }

    text = prepareText(text, format);

    const tasks = [];
    const texts = splitText(text);

    apiSettings.format = formatModule.getApiFormat(format);

    texts.forEach(function(el, i) {
        printDebug({
            request: i,
            format: format,
            apiFormat: apiSettings.format,
            lang: apiSettings.lang,
            options: apiSettings.options,
            text: el.substring(0, 128)
        });

        tasks.push(function(cb) {
            yaspellerApi.checkText(el, function(error, body) {
                if (error) {
                    cb(null, [true, error]);
                } else {
                    cb(null, [false, body]);
                }
            }, apiSettings);
        });
    });

    async.parallelLimit(tasks, getMaxRequest(apiSettings), function(err, data) {
        const buf = mergeResults(data);

        if (!buf.err && apiSettings.checkYo) {
            checkYo(text, buf.data);
        }

        callback(buf.err, buf.data, originalText);
    });
}

function checkYo(text, data) {
    eyo(text).forEach(function(el) {
        data.push({
            code: 100,
            position: el.position,
            word: el.before,
            s: [el.after],
            count: el.count
        });
    });
}

function splitText(text) {
    const texts = [];

    let pos = 0;
    let newPos = 0;

    while (pos < text.length) {
        if (pos + MAX_LEN_TEXT >= text.length) {
            texts.push(text.substring(pos));
            break;
        } else {
            newPos = getPosition(text, pos + MAX_LEN_TEXT);
            texts.push(text.substring(pos, newPos));
            pos = newPos;
        }
    }

    return texts;
}

function getPosition(text, start) {
    const depth = 500; // MAX_LEN_TEXT / 20
    for (let i = start - 1; i >= start - depth; i--) {
        const sym = text[i];
        if (sym === ' ' || sym === '\n' || sym === '\t') {
            return i;
        }
    }

    return start;
}

function mergeResults(res) {
    let err = false;
    let data = [];

    res.some(function(el) {
        if (el[0]) {
            err = true;
            data = el[1];
            return true;
        }

        return false;
    });

    if (!err) {
        res.forEach(function(el) {
            data = data.concat(el[1]);
        });
    }

    return {
        err: err,
        data: data
    };
}

/**
 * Check text in file on typos.
 *
 * @param {string} file
 * @param {Function} callback
 * @param {Object} [settings] See {@tutorial options}
 */
function checkFile(file, callback, settings) {
    settings = settings || {};
    settings.extname = pth.extname(file);

    printDebug('get: ' + file);

    if (fs.existsSync(file)) {
        if (fs.statSync(file).isFile()) {
            const buf = fs.readFileSync(file);
            if (isutf8(buf)) {
                printDebug('post text -> Yandex.Speller API: ' + file);

                const startTime = Date.now();
                checkText(buf.toString(), function(err, data, originalText) {
                    callback(
                        err,
                        err ? data : {resource: file, data: data, time: Date.now() - startTime},
                        originalText
                    );
                }, settings);
            } else {
                callback(true, Error(file + ': is not utf-8'));
            }
        } else {
            callback(true, Error(file + ': is not file'));
        }
    } else {
        callback(true, Error(file + ': is not exists'));
    }
}

/**
 * Check text on link for typos.
 *
 * @param {string} url
 * @param {Function} callback
 * @param {Object} [settings] See {@tutorial settings}
 */
function checkUrl(url, callback, settings) {
    settings = settings || {};
    settings.extname = pth.extname(url);

    printDebug('get: ' + url);

    request.get({
        method: 'GET',
        uri: url,
        gzip: true
    },
    function(error, response, text) {
        if (error) {
            callback(true, error);
            return;
        }

        if (response.statusCode !== 200) {
            callback(true, Error(url + ': returns status code is ' + response.statusCode));
            return;
        }

        const startTime = Date.now();
        checkText(text, function(err, data, originalText) {
            callback(
                err,
                err ? data : {resource: url, data: data, time: Date.now() - startTime},
                originalText
            );
        }, settings);
    });
}

/**
 * Check text on pages of sitemap.xml.
 *
 * @param {string} url
 * @param {Function} commonCallback - Common callback
 * @param {Object} [settings] See {@tutorial settings}
 * @param {Function} [callback] callback - Callback on each url.
 */
function checkSitemap(url, commonCallback, settings, callback) {
    settings = settings || {};

    const results = [];

    printDebug('get: ' + url);

    request.get(url, function(error, response, xml) {
        let obj;

        if (error) {
            obj = [true, error];
            results.push(obj);
            callback && callback.apply(this, obj);
            commonCallback(results);

            return;
        }

        if (response.statusCode !== 200) {
            obj = [true, Error(url + ': returns status code is ' + response.statusCode)];
            results.push(obj);
            callback && callback.apply(this, obj);
            commonCallback(results);

            return;
        }

        const parser = new xml2js.Parser();
        parser.parseString(xml, function(err, result) {
            if (err) {
                let obj = [true, Error(url + ': error parsing xml')];
                results.push(obj);
                callback && callback.apply(this, obj);
                commonCallback(results);
                return;
            }

            const tasks = [];
            if (result && result.urlset && Array.isArray(result.urlset.url)) {
                result.urlset.url.forEach(function(el) {
                    el.loc && el.loc.forEach(function(url) {
                        tasks.push(function(cb) {
                            checkUrl(url, function(err, data, originalText) {
                                callback && callback(err, data, originalText);
                                cb(null, [err, data]);
                            }, settings);
                        });
                    });
                });
            }

            async.parallelLimit(tasks, getMaxRequest(settings), function(err, data) {
                commonCallback(data);
            });
        });
    });
}

/**
 * Add positions (line number and column number) for typos.
 *
 * @param {string} text
 * @param {Object[]} data - Array of typos.
 */
function addPositions(text, data) {
    data.forEach(function(item) {
        if (item.code === TOO_MANY_ERRORS || item.position) {
            return;
        }

        const result = [];
        const letters = '[^a-zA-Zа-яА-ЯЁёҐґЄєІіЇї]';

        text.replace(new RegExp(item.word + '(?:' + letters + '|$)', 'g'), function($0, index) {
            const prevSymbol = text[index - 1];
            if (prevSymbol && prevSymbol.search(letters) === -1) {
                return;
            }

            const lines = text.substr(0, index).split(/\r\n|\n|\r/);

            result.push({
                line: lines.length,
                column: lines[lines.length - 1].length + 1
            });
        });

        item.position = item.count >= result.length ? result : [];
    });
}

/**
 * Remove duplicates in typos.
 *
 * @param {Object[]} data - Array of typos.
 * @returns {Object[]}
 */
function removeDuplicates(data) {
    const result = [];
    const obj = {};

    data.forEach(function(el) {
        const code = el.code;
        const word = el.word;
        const s = el.s;
        const hasPosition = Array.isArray(el.position);

        if (!word) {
            return;
        }

        obj[code] = obj[code] || {};

        if (!obj[code][word]) {
            obj[code][word] = {
                code,
                word,
                count: el.count || 1,
            };

            if (Array.isArray(s) && s.length) {
                obj[code][word].suggest = s;
            }
            
            if (hasPosition) {
                obj[code][word].position = el.position;
            }
        } else {
            const objWord = obj[code][word];
            objWord.count += el.count || 1;
            if (hasPosition) {
                objWord.position = Array.isArray(objWord.position) ?
                    objWord.position.concat(el.position) :
                    el.position;
            }
        }
    });

    Object.keys(obj).forEach(function(code) {
        Object.keys(obj[code]).sort().forEach(function(word) {
            result.push(obj[code][word]);
        });
    });

    return result;
}

/**
 * Sort results by positions.
 *
 * @param {Object[]} data
 */
function sortByPositions(data) {
    data.sort(function(a, b) {
        const codeA = a.code;
        const codeB = b.code;

        // Sort by a code
        if (codeA > codeB) {
            return 1;
        }
        if (codeA < codeB) {
            return -1;
        }

        const posA = a.position;
        const posB = b.position;

        // No position
        if (!posA.length || !posB.length) {
            if (posA.length === posB.length) {
                // Sort by a word
                return a.word.toLowerCase() > b.word.toLowerCase() ? 1 : -1;
            }

            if (posA.length < posB.length) {
                return 1;
            }

            return -1;
        } else {
            // Sort by a line
            const lineA = posA[0].line;
            const lineB = posB[0].line;
            if (lineA > lineB) {
                return 1;
            }

            if (lineA < lineB) {
                return -1;
            }

            // Sort by a column
            const colA = posA[0].column;
            const colB = posB[0].column;
            if (colA > colB) {
                return 1;
            }

            if (colA < colB) {
                return -1;
            }

            return 0;
        }
    });
}

function prepareText(text) {
    text = fixLineEndings(text);
    text = removeSpecialSymbols(text);

    return text.trim();
}

function fixLineEndings(text) {
    return text.replace(/\r\n/g, '\n') // Fix Windows
        .replace(/\r/g, '\n') // Fix MacOS
        .replace(/\s+\n/g, '\n') // Trailling spaces
        .replace(/\s+/g, ' ') // Repeat spaces
        .replace(/\n+/g, '\n'); // Repeat line endings
}

function removeSpecialSymbols(text) {
    return text
        // en: aeiouy
        // ru: аеёиоуыэюя
        // uk: аеєиіїоуюя
        .replace(/([aeiouyаеёиоуыэюяєії])\u0301/gi, '$1') // Acute accent
        // eslint-disable-next-line no-misleading-character-class
        .replace(/[\u200c\u200d\u00ad]/g, ''); // Zero-width non-joiner, Zero-width joiner and shy
}

function getErrors() {
    return yaspellerApi.errorCodes.filter(function(el) {
        return el.code !== TOO_MANY_ERRORS;
    }).map(function(el) {
        return {
            code: el.code,
            title: el.text
        };
    }).concat({
        code: 100, // ERROR_EYO
        title: 'Letter Ё (Yo)'
    });
}

module.exports = {
    addPositions,
    errors: getErrors(),
    checkFile,
    checkSitemap,
    checkText,
    checkUrl,
    removeDuplicates,
    sortByPositions
};
