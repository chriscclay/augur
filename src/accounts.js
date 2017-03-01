/**
 * Client-side accounts
 */

"use strict";

var NODE_JS = (typeof module !== "undefined") && process && !process.browser;

var async = require("async");
var BigNumber = require("bignumber.js");
var EthTx = require("ethereumjs-tx");
var keys = require("keythereum");
var uuid = require("uuid");
var clone = require("clone");
var locks = require("locks");
var request = (NODE_JS) ? require("request") : require("browser-request");
var abi = require("augur-abi");
var errors = require("ethrpc").errors;
var constants = require("./constants");
var utils = require("./utilities");

request = request.defaults({timeout: 999999});

keys.constants.pbkdf2.c = constants.ROUNDS;
keys.constants.scrypt.n = constants.ROUNDS;

module.exports = function () {

  var augur = this;
  return {

    // The account object is set when logged in
    account: {},

    // free (testnet) ether for new accounts on registration
    fundNewAccountFromFaucet: function (registeredAddress, branch, onSent, onSuccess, onFailed) {
      onSent = onSent || utils.noop;
      onSuccess = onSuccess || utils.noop;
      onFailed = onFailed || utils.noop;
      if (registeredAddress === undefined || registeredAddress === null || registeredAddress.constructor !== String) {
        return onFailed(registeredAddress);
      }
      var url = constants.FAUCET + abi.format_address(registeredAddress);
      if (augur.options.debug.accounts) console.debug("fundNewAccountFromFaucet:", url);
      request(url, function (err, response, body) {
        if (augur.options.debug.accounts) {
          console.log("faucet err:", err);
          console.log("faucet response:", response);
          console.log("faucet body:", body);
        }
        if (err) return onFailed(err);
        if (response.statusCode !== 200) {
          return onFailed(response.statusCode);
        }
        if (augur.options.debug.accounts) console.debug("Sent ether to:", registeredAddress);
        augur.rpc.balance(registeredAddress, function (ethBalance) {
          if (augur.options.debug.accounts) console.debug("Balance:", ethBalance);
          var balance = parseInt(ethBalance, 16);
          if (balance > 0) {
            augur.fundNewAccount({
              branch: branch || constants.DEFAULT_BRANCH_ID,
              onSent: onSent,
              onSuccess: onSuccess,
              onFailed: onFailed
            });
          } else {
            async.until(function () {
              return balance > 0;
            }, function (callback) {
              augur.rpc.fastforward(1, function (nextBlock) {
                if (augur.options.debug.accounts) console.log("Block:", nextBlock);
                augur.rpc.balance(registeredAddress, function (ethBalance) {
                  if (augur.options.debug.accounts) console.debug("Balance:", ethBalance);
                  balance = parseInt(ethBalance, 16);
                  callback(null, balance);
                });
              });
            }, function (e, balance) {
              if (e) console.error(e);
              augur.fundNewAccount({
                branch: branch || constants.DEFAULT_BRANCH_ID,
                onSent: onSent,
                onSuccess: onSuccess,
                onFailed: onFailed
              });
            });
          }
        });
      });
    },

    fundNewAccountFromAddress: function (fromAddress, amount, registeredAddress, branch, onSent, onSuccess, onFailed) {
      onSent = onSent || utils.noop;
      onSuccess = onSuccess || utils.noop;
      onFailed = onFailed || utils.noop;
      augur.rpc.sendEther({
        to: registeredAddress,
        value: amount,
        from: fromAddress,
        onSent: utils.noop,
        onSuccess: function (res) {
          augur.fundNewAccount({
            branch: branch || constants.DEFAULT_BRANCH_ID,
            onSent: onSent,
            onSuccess: onSuccess,
            onFailed: onFailed
          });
        },
        onFailed: onFailed
      });
    },

    register: function (password, cb) {
      var self = this;
      cb = (utils.is_function(cb)) ? cb : utils.pass;
      if (!password || password.length < 6) return cb(errors.PASSWORD_TOO_SHORT);

      // generate ECDSA private key and initialization vector
      keys.create(null, function (plain) {
        if (plain.error) return cb(plain);

        // derive secret key from password
        keys.deriveKey(password, plain.salt, {kdf: constants.KDF}, function (derivedKey) {
          if (derivedKey.error) return cb(derivedKey);
          if (!Buffer.isBuffer(derivedKey)) {
            derivedKey = new Buffer(derivedKey, "hex");
          }
          var encryptedPrivateKey = new Buffer(keys.encrypt(
            plain.privateKey,
            derivedKey.slice(0, 16),
            plain.iv
          ), "base64").toString("hex");

          // encrypt private key using derived key and IV, then
          // store encrypted key & IV, indexed by handle
          var address = abi.format_address(keys.privateKeyToAddress(plain.privateKey));
          var kdfparams = {
            dklen: keys.constants[constants.KDF].dklen,
            salt: plain.salt.toString("hex")
          };
          if (constants.KDF === "scrypt") {
            kdfparams.n = keys.constants.scrypt.n;
            kdfparams.r = keys.constants.scrypt.r;
            kdfparams.p = keys.constants.scrypt.p;
          } else {
            kdfparams.c = keys.constants.pbkdf2.c;
            kdfparams.prf = keys.constants.pbkdf2.prf;
          }
          var keystore = {
            address: address,
            crypto: {
              cipher: keys.constants.cipher,
              ciphertext: encryptedPrivateKey,
              cipherparams: {iv: plain.iv.toString("hex")},
              kdf: constants.KDF,
              kdfparams: kdfparams,
              mac: keys.getMAC(derivedKey, encryptedPrivateKey)
            },
            version: 3,
            id: uuid.v4()
          };

          // while logged in, account object is set
          self.account = {
            privateKey: plain.privateKey,
            address: address,
            keystore: keystore,
            derivedKey: derivedKey
          };

          return cb(clone(self.account));
        }); // deriveKey
      }); // create
    },

    importAccount: function (password, keystore, cb) {
      var self = this;
      cb = (utils.is_function(cb)) ? cb : utils.pass;
      if (!password || password === "") return cb(errors.BAD_CREDENTIALS);
      keys.recover(password, keystore, function (privateKey) {
        if (!privateKey || privateKey.error) return cb(errors.BAD_CREDENTIALS);

        var keystoreCrypto = keystore.crypto || keystore.Crypto;

        keys.deriveKey(password, keystoreCrypto.kdfparams.salt, {kdf: constants.KDF}, function (derivedKey) {
          self.account = {
            privateKey: privateKey,
            address: abi.format_address(keystore.address),
            keystore: keystore,
            derivedKey: derivedKey
          };

          return cb(clone(self.account));
        });
      });
    },

    setAccountObject: function (account, cb) {
      var privateKey = account.privateKey;
      var derivedKey = account.derivedKey;
      if (privateKey && !Buffer.isBuffer(privateKey)) {
        privateKey = new Buffer(privateKey, "hex");
      }
      if (derivedKey && !Buffer.isBuffer(derivedKey)) {
        derivedKey = new Buffer(derivedKey, "hex");
      }
      this.account = {
        privateKey: privateKey,
        address: abi.format_address(account.keystore.address),
        keystore: account.keystore,
        derivedKey: derivedKey
      };
    },

    login: function (keystore, password, cb) {
      var self = this;
      cb = (utils.is_function(cb)) ? cb : utils.pass;
      if (!keystore || !password || password === "") return cb(errors.BAD_CREDENTIALS);
      var keystoreCrypto = keystore.crypto || keystore.Crypto;

      // derive secret key from password
      keys.deriveKey(password, keystoreCrypto.kdfparams.salt, {
        kdf: keystoreCrypto.kdf,
        kdfparams: keystoreCrypto.kdfparams,
        cipher: keystoreCrypto.kdf
      }, function (derivedKey) {
        if (!derivedKey || derivedKey.error) return cb(errors.BAD_CREDENTIALS);

        // verify that message authentication codes match
        var storedKey = keystoreCrypto.ciphertext;
        if (keys.getMAC(derivedKey, storedKey) !== keystoreCrypto.mac.toString("hex")) {
          return cb(errors.BAD_CREDENTIALS);
        }

        if (!Buffer.isBuffer(derivedKey)) {
          derivedKey = new Buffer(derivedKey, "hex");
        }

        // decrypt stored private key using secret key
        try {
          var privateKey = new Buffer(keys.decrypt(
            storedKey,
            derivedKey.slice(0, 16),
            keystoreCrypto.cipherparams.iv
          ), "hex");

          // while logged in, account object is set
          self.account = {
            privateKey: privateKey,
            address: abi.format_address(keystore.address),
            keystore: keystore,
            derivedKey: derivedKey
          };
          return cb(clone(self.account));

          // decryption failure: bad password
        } catch (exc) {
          var e = clone(errors.BAD_CREDENTIALS);
          e.bubble = exc;
          return cb(e);
        }
      }); // deriveKey
    },

    // user-supplied plaintext private key
    loginWithMasterKey: function (privateKey, cb) {
      if (!Buffer.isBuffer(privateKey)) privateKey = new Buffer(privateKey, "hex");
      this.account = {
        address: abi.format_address(keys.privateKeyToAddress(privateKey)),
        privateKey: privateKey,
        derivedKey: new Buffer(abi.unfork(utils.sha256(privateKey)), "hex")
      };
      return cb(clone(this.account));
    },

    logout: function () {
      this.account = {};
      augur.rpc.clear();
    },

    submitTx: function (packaged, cb) {
      var self = this;
      var mutex = locks.createMutex();
      mutex.lock(function () {
        for (var rawTxHash in augur.rpc.rawTxs) {
          if (!augur.rpc.rawTxs.hasOwnProperty(rawTxHash)) continue;
          if (augur.rpc.rawTxs[rawTxHash].tx.nonce === packaged.nonce && (!augur.rpc.txs[rawTxHash] || augur.rpc.txs[rawTxHash].status !== "failed")) {
            packaged.nonce = abi.hex(augur.rpc.rawTxMaxNonce + 1);
            if (augur.rpc.debug.broadcast || augur.rpc.debug.nonce) {
              console.debug("[augur.js] duplicate nonce, incremented:", parseInt(packaged.nonce, 16), augur.rpc.rawTxMaxNonce);
            }
            break;
          }
        }
        if (parseInt(packaged.nonce, 16) <= augur.rpc.rawTxMaxNonce) {
          packaged.nonce = abi.hex(++augur.rpc.rawTxMaxNonce);
        } else {
          augur.rpc.rawTxMaxNonce = parseInt(packaged.nonce, 16);
        }
        if (augur.rpc.debug.broadcast || augur.rpc.debug.nonce) {
          console.debug("[augur.js] nonce:", parseInt(packaged.nonce, 16), augur.rpc.rawTxMaxNonce);
        }
        mutex.unlock();
        if (augur.rpc.debug.broadcast) {
          console.log("[augur.js] packaged:", JSON.stringify(packaged, null, 2));
        }
        var etx = new EthTx(packaged);

        // sign, validate, and send the transaction
        etx.sign(self.account.privateKey);
        if (augur.rpc.debug.tx) {
          console.log("rawTx nonce:    0x" + etx.nonce.toString("hex"));
          console.log("rawTx gasPrice: 0x" + etx.gasPrice.toString("hex"));
          console.log("rawTx gasLimit: 0x" + etx.gasLimit.toString("hex"));
          console.log("rawTx to:       0x" + etx.to.toString("hex"));
          console.log("rawTx value:    0x" + etx.value.toString("hex"));
          console.log("rawTx v:        0x" + etx.v.toString("hex"));
          console.log("rawTx r:        0x" + etx.r.toString("hex"));
          console.log("rawTx s:        0x" + etx.s.toString("hex"));
          console.log("rawTx data:     0x" + etx.data.toString("hex"));
        }

        // calculate the cost (in ether) of this transaction
        // (note: this is just an upper bound on the cost, set by the gasLimit!)
        var cost = etx.getUpfrontCost().toString();

        // transaction validation
        if (!etx.validate()) return cb(errors.TRANSACTION_INVALID);

        // send the raw signed transaction to geth
        augur.rpc.sendRawTx(etx.serialize().toString("hex"), function (res) {
          if (augur.rpc.debug.broadcast) console.debug("[augur.js] sendRawTx response:", res);
          if (!res) return cb(errors.RAW_TRANSACTION_ERROR);
          if (res.error) {
            if (res.message.indexOf("rlp") > -1) {
              var err = clone(errors.RLP_ENCODING_ERROR);
              err.bubble = res;
              err.packaged = packaged;
              return cb(err);
            } else if (res.message.indexOf("Nonce too low") > -1) {
              if (augur.rpc.debug.broadcast || augur.rpc.debug.nonce) {
                console.debug("[augur.js] Bad nonce, retrying:", res.message, packaged, augur.rpc.rawTxMaxNonce);
              }
              ++augur.rpc.rawTxMaxNonce;
              delete packaged.nonce;
              return self.getTxNonce(packaged, cb);
            }
            return cb(res);
          }

          // res is the txhash if nothing failed immediately
          // (even if the tx is nulled, still index the hash)
          augur.rpc.rawTxs[res] = {tx: packaged, cost: abi.unfix(cost, "string")};

          // nonce ok, execute callback
          return cb(res);
        });
      });
    },

    // get nonce: number of transactions
    getTxNonce: function (packaged, cb) {
      var self = this;
      if (packaged.nonce) return this.submitTx(packaged, cb);
      augur.rpc.pendingTxCount(self.account.address, function (txCount) {
        if (augur.rpc.debug.nonce) {
          console.debug('[augur.js] txCount:', parseInt(txCount, 16));
        }
        if (txCount && !txCount.error && !(txCount instanceof Error)) {
          packaged.nonce = abi.hex(txCount);
        }
        self.submitTx(packaged, cb);
      });
    },

    invoke: function (payload, cb) {
      var self = this;
      if (!payload || payload.constructor !== Object) {
        if (cb && cb.constructor === Function) return cb(errors.TRANSACTION_FAILED);
        return errors.TRANSACTION_FAILED;
      }
      // if this is just a call, use ethrpc's regular invoke method
      if (!payload.send) {
        if (augur.rpc.debug.broadcast) {
          console.log("[augur.js] eth_call payload:", payload);
        }
        return augur.rpc.fire(payload, cb);
      }
      cb = cb || utils.pass;

      if (!this.account.address || !this.account.privateKey) {
        return cb(errors.NOT_LOGGED_IN);
      }
      // parse and serialize transaction parameters
      var packaged = augur.rpc.packageRequest(payload);
      packaged.from = this.account.address;
      packaged.nonce = payload.nonce || "0x0";
      packaged.value = payload.value || "0x0";
      if (payload.gasLimit) {
        packaged.gasLimit = abi.hex(payload.gasLimit);
      } else if (augur.rpc.block && augur.rpc.block.gasLimit) {
        packaged.gasLimit = abi.hex(augur.rpc.block.gasLimit);
      } else {
        packaged.gasLimit = abi.hex(constants.DEFAULT_GAS);
      }
      if (augur.network_id && !isNaN(parseInt(augur.network_id, 10)) && parseInt(augur.network_id, 10) < 109) {
        packaged.chainId = parseInt(augur.network_id, 10);
      }
      if (augur.rpc.debug.broadcast) {
        console.log("[augur.js] payload:", payload);
      }
      if (payload.gasPrice && abi.number(payload.gasPrice) > 0) {
        packaged.gasPrice = payload.gasPrice;
        return this.getTxNonce(packaged, cb);
      }
      augur.rpc.getGasPrice(function (gasPrice) {
        if (!gasPrice || gasPrice.error) {
          return cb(errors.TRANSACTION_FAILED);
        }
        packaged.gasPrice = gasPrice;
        self.getTxNonce(packaged, cb);
      });
    }

  };
};
