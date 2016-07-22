'use strict';

const _ = require('lodash');
const mocha = require('mocha');
const assert = require('assert');
const dotenv = require('dotenv');
const S3Auth = require('aws-sdk/lib/signers/s3');

const P = require('../../util/promise');
const coretest = require('./coretest');

dotenv.load();
const s3_auth = new S3Auth();

mocha.describe('system_servers', function() {

    const PREFIX = 'coretest';
    const SYS = PREFIX + '-system';
    const POOL = PREFIX + '-pool';
    const TIER = PREFIX + '-tier';
    const TIERING_POLICY = PREFIX + '-tiering-policy';
    const BUCKET = PREFIX + '-bucket';
    const SYS1 = SYS + '-1';
    const EMAIL_DOMAIN = '@coretest.coretest';
    const EMAIL = SYS + EMAIL_DOMAIN;
    const EMAIL1 = SYS1 + EMAIL_DOMAIN;
    const PASSWORD = SYS + '-password';
    const ACCESS_KEYS = {
        access_key: 'ydaydayda',
        secret_key: 'blablabla'
    };
    const CLOUD_SYNC_CONNECTION = 'Connection 1';

    const client = coretest.new_test_client();

    mocha.it('works', function() {
        this.timeout(60000);
        let nodes_list;
        return P.resolve()
            ///////////////
            //  ACCOUNT  //
            ///////////////
            .then(() => client.account.accounts_status())
            .then(res => assert(!res.has_accounts, '!has_accounts'))
            .then(() => client.system.create_system({
                name: SYS,
                email: EMAIL,
                password: PASSWORD,
                access_keys: ACCESS_KEYS
            }))
            .then(res => {
                client.options.auth_token = res.token;
            })
            .then(() => client.account.accounts_status())
            .then(res => assert(res.has_accounts, 'has_accounts'))
            .then(() => client.account.read_account({
                email: EMAIL
            }))
            .then(() => client.account.list_accounts())
            .then(() => client.account.get_account_sync_credentials_cache())
            .then(() => client.system.read_system())
            .then(() => client.account.update_account({
                email: EMAIL,
                name: SYS1,
            }))
            .then(() => client.system.update_system({
                name: SYS1,
            }))
            .then(() => client.system.read_system())
            .then(() => client.system.update_system({
                name: SYS,
            }))
            .then(() => client.account.create_account({
                name: EMAIL1,
                email: EMAIL1,
                password: PASSWORD,
                access_keys: ACCESS_KEYS
            }))
            .then(() => client.system.read_system())
            .then(() => client.system.add_role({
                email: EMAIL1,
                role: 'admin',
            }))
            .then(() => client.system.read_system())
            .then(() => client.system.remove_role({
                email: EMAIL1,
                role: 'admin',
            }))
            .then(() => client.system.read_system())
            .then(() => client.account.delete_account({
                email: EMAIL1
            }))
            .then(() => client.system.read_system())
            .then(() => client.system.list_systems())
            .then(() => client.system.read_activity_log({
                limit: 2016
            }))
            ////////////
            //  AUTH  //
            ////////////
            .then(() => client.auth.read_auth())
            .then(() => client.auth.create_auth({
                email: EMAIL,
                password: PASSWORD,
                system: SYS,
            }))
            .then(() => {
                return P.resolve(client.system.read_system())
                    .then(res => client.auth.create_access_key_auth({
                        access_key: res.owner.access_keys[0].access_key,
                        string_to_sign: '',
                        signature: s3_auth.sign(res.owner.access_keys[0].secret_key, '')
                    }));
            })
            //////////////
            //  SYSTEM  //
            //////////////
            .then(() => client.system.update_base_address({
                base_address: 'fcall://fcall'
            }))
            .then(() => client.system.update_n2n_config({
                tcp_active: true
            }))
            .then(() => client.system.update_system_certificate()
                .catch(err => assert.deepEqual(err.rpc_code, 'TODO'))
            )
            //.then(() => client.system.start_debug({level:0}))
            .then(() => client.system.diagnose_system())
            .then(() => client.create_auth_token({
                email: EMAIL,
                password: PASSWORD,
                system: SYS1,
            }))
            .then(() => client.system.delete_system())
            .then(() => client.create_auth_token({
                email: EMAIL,
                password: PASSWORD,
                system: SYS,
            }))
            ////////////
            //  POOL  //
            ////////////
            .then(() => coretest.init_test_nodes(client, SYS, 6))
            .then(() => client.node.list_nodes({}))
            .then(res => {
                nodes_list = res.nodes;
            })
            .then(() => client.pool.create_nodes_pool({
                name: POOL,
                nodes: _.map(nodes_list.slice(0, 3),
                    node => _.pick(node, 'name')),
            }))
            .then(() => client.pool.read_pool({
                name: POOL,
            }))
            .then(() => client.pool.update_pool({
                name: POOL,
                new_name: POOL + 1,
            }))
            .then(() => client.pool.assign_nodes_to_pool({
                name: POOL + 1,
                nodes: _.map(nodes_list.slice(3, 6),
                    node => _.pick(node, 'name')),
            }))
            .then(() => client.pool.update_pool({
                name: POOL + 1,
                new_name: POOL,
            }))
            .then(() => client.pool.assign_nodes_to_pool({
                name: 'default_pool',
                nodes: _.map([nodes_list[1], nodes_list[3], nodes_list[5]],
                    node => _.pick(node, 'name')),
            }))
            .then(() => client.system.read_system())
            .then(() => client.pool.list_pool_nodes({
                name: POOL
            }))
            .then(() => client.pool.get_associated_buckets({
                name: POOL
            }))
            ////////////
            //  TIER  //
            ////////////
            .then(() => client.tier.create_tier({
                name: TIER,
                node_pools: [POOL],
                data_placement: 'SPREAD',
                replicas: 17,
                data_fragments: 919,
                parity_fragments: 42,
            }))
            .then(() => client.tier.read_tier({
                name: TIER,
            }))
            .then(() => client.tier.update_tier({
                name: TIER,
                replicas: 980
            }))
            .then(() => client.system.read_system())
            //////////////////////
            //  TIERING_POLICY  //
            //////////////////////
            .then(() => client.tiering_policy.create_policy({
                name: TIERING_POLICY,
                tiers: [{
                    order: 0,
                    tier: TIER
                }]
            }))
            .then(() => client.tiering_policy.read_policy({
                name: TIERING_POLICY
            }))
            .then(() => client.tiering_policy.update_policy({
                    name: TIERING_POLICY,
                    tiers: [{
                        order: 0,
                        tier: TIER
                    }, {
                        order: 1,
                        tier: TIER
                    }]
                })
                .catch(err => assert.deepEqual(err.rpc_code, 'TODO'))
            )
            .then(() => client.tiering_policy.get_policy_pools({
                name: TIERING_POLICY
            }))
            .then(() => client.system.read_system())
            // //////////////
            // //  BUCKET  //
            // //////////////
            .then(() => client.bucket.create_bucket({
                name: BUCKET,
                tiering: TIERING_POLICY,
            }))
            .then(() => client.bucket.read_bucket({
                name: BUCKET,
            }))
            .then(() => client.bucket.list_buckets())
            .then(() => client.bucket.update_bucket({
                name: BUCKET,
                new_name: BUCKET + 1,
                tiering: TIERING_POLICY //'default_tiering',
            }))
            .then(() => client.bucket.read_bucket({
                name: BUCKET + 1,
            }))
            .then(() => client.bucket.update_bucket({
                name: BUCKET + 1,
                new_name: BUCKET,
            }))
            .then(() => client.account.add_account_sync_credentials_cache({
                name: CLOUD_SYNC_CONNECTION,
                endpoint: 'https://s3.amazonaws.com',
                access_key: process.env.AWS_ACCESS_KEY_ID,
                secret_key: process.env.AWS_SECRET_ACCESS_KEY
            }))
            .then(() => client.bucket.set_cloud_sync({
                name: BUCKET,
                connection: CLOUD_SYNC_CONNECTION,
                target_bucket: BUCKET,
                policy: {
                    schedule_min: 11
                }
            }))
            .then(() => client.bucket.get_cloud_buckets({
                connection: CLOUD_SYNC_CONNECTION
            }))
            .then(() => client.system.read_system())
            .then(() => client.bucket.get_cloud_sync({
                name: BUCKET,
            }))
            .then(() => client.bucket.delete_cloud_sync({
                name: BUCKET,
            }))
            .then(() => client.bucket.get_all_cloud_sync())
            .then(() => client.system.read_system())
            // /////////////
            // //  STATS  //
            // /////////////
            .then(() => client.stats.get_systems_stats({}))
            .then(() => client.stats.get_nodes_stats({}))
            .then(() => client.stats.get_ops_stats({}))
            .then(() => client.stats.get_all_stats({}))
            ////////////
            //  MISC  //
            ////////////
            .then(() => client.debug.set_debug_level({
                module: 'rpc',
                level: 0
            }))
            /////////////////
            //  deletions  //
            /////////////////
            .then(() => client.bucket.delete_bucket({
                name: BUCKET,
            }))
            .then(() => client.tiering_policy.delete_policy({
                    name: TIERING_POLICY,
                })
                .then(res => {
                    throw new Error('TIERING_POLICY: ' + TIERING_POLICY +
                        ' should have been deleted by now');
                })
                .catch(err => {
                    if (err.rpc_code !== 'NO_SUCH_TIERING_POLICY') throw err;
                })
            )
            .then(() => client.tier.delete_tier({
                    name: TIER,
                })
                .then(() => {
                    throw new Error('TIER: ' + TIER +
                        ' should have been deleted by now');
                })
                .catch(err => {
                    if (err.rpc_code !== 'NO_SUCH_TIER') throw err;
                })
            )
            .then(() => client.pool.assign_nodes_to_pool({
                name: 'default_pool',
                nodes: _.map(nodes_list, node => _.pick(node, 'name')),
            }))
            .then(() => coretest.clear_test_nodes())
            .then(() => client.pool.delete_pool({
                name: POOL,
            }))
            .then(() => client.system.read_system())
            .then(() => client.system.delete_system());
    });
});
