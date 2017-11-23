/* Copyright (C) 2016 NooBaa */
'use strict';

const _ = require('lodash');
const util = require('util');

const dbg = require('../../util/debug_module')(__filename);
const config = require('../../../config');
const size_utils = require('../../util/size_utils');
const system_store = require('../system_services/system_store').get_instance();


/**
 *
 *
 * ChunkMapper
 *
 *
 */
class ChunkMapper {

    constructor(chunk) {
        this.chunk = chunk;
        this.is_write = !chunk._id;
        this.frags_by_index = _.keyBy(chunk.frags, _frag_index);
        const frags_by_id = _.keyBy(chunk.frags, '_id');
        this.blocks_by_index = _.groupBy(chunk.blocks, block => _frag_index(frags_by_id[block.frag]));
        this.accessible = this.is_accessible();
    }

    is_accessible() {

        const {
            blocks_by_index,
            chunk: {
                chunk_coder_config: {
                    data_frags = 1,
                    parity_frags = 0,
                }
            },
        } = this;

        let num_accessible = 0;

        for (let data_index = 0; data_index < data_frags; ++data_index) {
            const frag_index = `D${data_index}`;
            const blocks = blocks_by_index[frag_index];
            if (blocks) {
                for (let i = 0; i < blocks.length; ++i) {
                    if (_is_block_accessible(blocks[i])) {
                        num_accessible += 1;
                        break;
                    }
                }
            }
        }
        if (num_accessible >= data_frags) return true;

        for (let parity_index = 0; parity_index < parity_frags; ++parity_index) {
            const frag_index = `P${parity_index}`;
            const blocks = blocks_by_index[frag_index];
            if (blocks) {
                for (let i = 0; i < blocks.length; ++i) {
                    if (_is_block_accessible(blocks[i])) {
                        num_accessible += 1;
                        break;
                    }
                }
            }
        }
        return num_accessible >= data_frags;
    }
}


/**
 *
 * 
 * MirrorMapper
 *
 * 
 */
class MirrorMapper {

    constructor(mirror, chunk_coder_config) {
        const { spread_pools } = mirror;
        this.spread_pools = spread_pools;
        this.chunk_coder_config = chunk_coder_config;
        this.pools_by_id = _.keyBy(spread_pools, '_id');
        if (!spread_pools.length) dbg.log1('MirrorMapper: no pools in current mirror', mirror);
        const pools_partitions = _.partition(spread_pools, _pool_has_redundancy);
        this.redundant_pools = pools_partitions[0];
        this.regular_pools = pools_partitions[1];
    }

    update_status(tier_status) {
        const { regular_pools, redundant_pools } = this;
        const pool_valid = pool => _get_valid_for_allocation(tier_status, pool._id);
        this.regular_pools_valid = false;
        this.redundant_pools_valid = false;

        // to decide which mirror to use for the first writing mirror
        // we set a weight for each mirror_mapper based on the pool types
        // when all are regular pools we 
        let regular_weight = 0;
        let redundant_weight = 0;
        for (let i = 0; i < regular_pools.length; ++i) {
            const pool = regular_pools[i];
            if (pool_valid(pool)) {
                this.regular_pools_valid = true;
                regular_weight = 3;
            }
        }
        for (let i = 0; i < redundant_pools.length; ++i) {
            const pool = redundant_pools[i];
            if (pool_valid(pool)) {
                this.redundant_pools_valid = true;
                redundant_weight = Math.min(redundant_weight, pool.mongo_pool_info ? 1 : 2);
            }
        }
        this.weight = redundant_weight || regular_weight;
    }

    is_best_write_mapper(best_mapper) {
        if (!best_mapper) return true;
        if (this.weight > best_mapper.weight) return true;
        if (this.weight < best_mapper.weight) return false;
        // when equal weight, pick at random to spread the writes load
        // we should add more data to this decosion such as pools available space and load factor.
        return Math.random() < 0.5;
    }

    map_mirror(chunk_mapper, tier_mapping) {

        const {
            chunk_coder_config: {
                replicas = 1,
                data_frags = 1,
                parity_frags = 0,
            }
        } = this;

        const {
            chunk: {
                is_special,
                chunk_coder_config: {
                    replicas: chunk_replicas = 1,
                    data_frags: chunk_data_frags = 1,
                    parity_frags: chunk_parity_frags = 0,
                }
            },
            is_write,
            frags_by_index,
            blocks_by_index,
        } = chunk_mapper;

        // TODO GUY GAP handle change of data_frags between tier vs. chunk
        let desired_data_frags = data_frags;
        let desired_parity_frags = parity_frags;
        let desired_replicas = replicas;
        if (data_frags !== chunk_data_frags) {
            dbg.log0(`MirrorMapper: tier frags ${data_frags}+${parity_frags}`,
                `requires recoding chunk ${chunk_data_frags}+${chunk_parity_frags}`,
                '(not yet implemented)');
            desired_data_frags = chunk_data_frags;
            desired_parity_frags = chunk_parity_frags;
            desired_replicas = chunk_replicas;
        }

        // max_replicas includes extra_allocations which are allocated opportunistically for special chunks
        const special_factor = is_special ? config.SPECIAL_CHUNK_REPLICA_MULTIPLIER : 1;
        const max_replicas = desired_replicas * special_factor;

        for (let data_index = 0; data_index < desired_data_frags; ++data_index) {
            const frag_index = `D${data_index}`;
            this._map_frag(
                tier_mapping,
                frags_by_index[frag_index],
                blocks_by_index[frag_index],
                desired_replicas,
                is_write,
                max_replicas);
        }
        for (let parity_index = 0; parity_index < desired_parity_frags; ++parity_index) {
            const frag_index = `P${parity_index}`;
            this._map_frag(
                tier_mapping,
                frags_by_index[frag_index],
                blocks_by_index[frag_index],
                desired_replicas,
                is_write,
                max_replicas);
        }
    }

    _map_frag(tier_mapping, frag, blocks, replicas, is_write, max_replicas) {
        const {
            pools_by_id,
            regular_pools,
            regular_pools_valid,
        } = this;
        const { blocks_in_use } = tier_mapping;

        const accessible_blocks = _.filter(blocks, _is_block_accessible);
        const accessible = accessible_blocks.length > 0;
        const used_blocks = [];

        if (!accessible && !is_write) {
            // TODO GUY GAP rebuild from other frags
        }

        let used_replicas = 0;
        let used_redundant_blocks = false;
        for (let i = 0; i < accessible_blocks.length; ++i) {
            const block = accessible_blocks[i];
            // block on pools that do not belong to the current mirror anymore
            // can be accessible but will eventually be deallocated
            const pool = pools_by_id[block.pool];
            const is_good_node = _is_block_good_node(block);
            if (is_good_node && pool) {
                used_blocks.push(block);
                // Also we calculate the weight of the current block allocations
                // Notice that we do not calculate bad blocks into the weight
                // We consider one replica in cloud/mongo valid for any policy
                if (_pool_has_redundancy(pool)) {
                    used_redundant_blocks = true;
                    used_replicas += max_replicas;
                } else {
                    used_replicas += 1;
                }
            }
        }

        if (used_replicas === max_replicas) {

            for (let i = 0; i < used_blocks.length; ++i) {
                blocks_in_use.push(used_blocks[i]);
            }

        } else if (used_replicas < max_replicas) {

            for (let i = 0; i < used_blocks.length; ++i) {
                blocks_in_use.push(used_blocks[i]);
            }

            const sources = {
                accessible_blocks,
                next_source: 0,
            };

            // We prefer to keep regular pools as much as possible
            const pools = regular_pools_valid && !used_redundant_blocks ? regular_pools : this._pick_pools();

            // num_missing of required replicas, which are a must to have for the chunk
            // In case of redundant pool allocation we consider one block as a fulfilment of all policy
            const is_redundant = _.every(pools, _pool_has_redundancy);
            const num_missing = is_redundant ? 1 : Math.max(0, replicas - used_replicas);


            // Notice that we push the minimum required replicas in higher priority
            // This is done in order to insure that we will allocate them before the additional replicas
            if (num_missing > 0) {
                tier_mapping.allocations = tier_mapping.allocations || [];
                for (let i = 0; i < num_missing; ++i) {
                    tier_mapping.allocations.push({ frag, pools, sources });
                }
            }

            // There is no point in special replicas when save in redundant alloc
            // These are the total missing blocks including the special blocks which are opportunistic
            if (!is_redundant) {
                const extra_missing = Math.max(0, max_replicas - num_missing - used_replicas);
                if (extra_missing > 0) {
                    tier_mapping.extra_allocations = tier_mapping.extra_allocations || [];
                    for (let i = 0; i < extra_missing; ++i) {
                        tier_mapping.extra_allocations.push({ frag, pools, sources, special_replica: true });
                    }
                }
            }

        } else {

            // To pick blocks to keep we sort by their creation timestamp in mongodb
            // and will keep newest blocks before older blocks
            // this approach helps to get rid of our "old" mapping decisions in favor of new decisions
            used_blocks.sort(_block_newer_first_sort);
            let keep_replicas = 0;
            for (let i = 0; i < used_blocks.length; ++i) {
                if (keep_replicas >= max_replicas) break;
                const block = used_blocks[i];
                keep_replicas += _pool_has_redundancy(pools_by_id[block.pool]) ? max_replicas : 1;
                blocks_in_use.push(block);
            }
        }
    }

    // Pick random pool which sets the allocation type between redundant/regular pools
    _pick_pools() {
        const { spread_pools } = this;
        const picked_pool = spread_pools[Math.max(_.random(spread_pools.length - 1), 0)];
        if (picked_pool && _pool_has_redundancy(picked_pool)) {
            return this.redundant_pools_valid ? this.redundant_pools : this.regular_pools;
        } else {
            return this.regular_pools_valid ? this.regular_pools : this.redundant_pools;
        }
    }
}


/**
 *
 *
 * TierMapper
 *
 * 
 */
class TierMapper {

    constructor({ tier, order, spillover }) {
        this.tier = tier;
        this.order = order;
        this.spillover = spillover;
        const { chunk_coder_config } = tier.chunk_config;
        this.mirror_mappers = tier.mirrors
            .map(mirror => new MirrorMapper(mirror, chunk_coder_config));
        this.write_mapper = this.mirror_mappers[0];
    }

    update_status(tier_status) {
        const { mirror_mappers } = this;
        this.write_mapper = undefined;

        for (let i = 0; i < mirror_mappers.length; ++i) {
            const mirror_mapper = mirror_mappers[i];
            mirror_mapper.update_status(tier_status);
            if (mirror_mapper.is_best_write_mapper(this.write_mapper)) {
                this.write_mapper = mirror_mapper;
            }
        }

        // TODO GUY GAP maximum between mirrors? not minimum?

        // We allow to upload to one mirror even if other mirrors don't have any space left
        // That is why we are picking the maximum value of free from the mirrors of the tier
        const available_to_upload = size_utils.json_to_bigint(size_utils.reduce_maximum(
            'free', tier_status.mirrors_storage.map(storage => (storage.free || 0))
        ));
        this.valid_for_allocation = available_to_upload &&
            available_to_upload.greater(config.MIN_TIER_FREE_THRESHOLD) &&
            available_to_upload.greater(config.MAX_TIER_FREE_THRESHOLD);
    }

    map_tier(chunk_mapper, best_mapper, best_mapping) {
        const { mirror_mappers, write_mapper } = this;
        const { is_write, accessible } = chunk_mapper;

        const tier_mapping = Object.seal({
            accessible,
            blocks_in_use: [],
            deletions: undefined,
            allocations: undefined,
            extra_allocations: undefined,
        });

        if (is_write) {
            write_mapper.map_mirror(chunk_mapper, tier_mapping);
        } else {
            // TODO GUY OPTIMIZE try to bail out faster if best_mapping is better
            for (let i = 0; i < mirror_mappers.length; ++i) {
                const mirror_mapper = mirror_mappers[i];
                mirror_mapper.map_mirror(chunk_mapper, tier_mapping);
            }
        }

        if (accessible && !tier_mapping.allocations) {
            const { blocks } = chunk_mapper.chunk;
            const unused_blocks = _.difference(blocks, tier_mapping.blocks_in_use);
            if (unused_blocks.length) tier_mapping.deletions = unused_blocks;
        }

        return tier_mapping;
    }

    /**
     * @returns true if tier_mapping is best, false if best_mapping is best.
     */
    is_best_tier(tier_mapping, chunk_mapper, best_mapper, best_mapping) {

        // PREFERED TIER PICKING DECISION TABLE
        // NOTICE:
        // Prior to the decision table below, we do a sortBy using several properties
        // The sortBy massively affects the outcome regarding which tier will be chosen
        // The below table hints the sorted array which type we shall choose
        // 
        // ST - Stands for SPILLOVER tier.
        // NT - Stands for NORMAL tier which means not spill over.
        // VC -  Stands for VALID chunk status on tier.
        // NVC - Stands for NOT VALID chunk status on tier.
        // VU -  Stands for tier which is VALID to upload (has free space).
        // NVU - Stands for tier which is NOT VALID to upload (has no free space).
        // 
        // Options for Normal Tier and Spillover Tier:
        // NT = { spillover_order: 1, chunk_good_order: VC/NVC, valid_order: VU/NVU, order: 1 },
        // ST = { spillover_order: 2, chunk_good_order: VC/NVC, valid_order: VU/NVU, order: 2 },
        // 
        // TODO: Current algorithm was developed for two tiers maximum
        // It may behave differently for more complex cases
        // 
        // +-------------------------------+-------------------+------------------+------------------+-----------------+
        // | Availability / Chunk Validity | NT: NVC - ST: NVC | NT: VC - ST: NVC | NT: NVC - ST: VC | NT: VC - ST: VC |
        // +-------------------------------+-------------------+------------------+------------------+-----------------+
        // | NT:   VU                      |    Normal Tier    |    Normal Tier   |    Normal Tier   |    Normal Tier  |
        // | ST:   VU                      |                   |                  |                  |                 |
        // +-------------------------------+-------------------+------------------+------------------+-----------------+
        // | NT:   NVU                     |    Normal Tier    |    Normal Tier   |                  |    Normal Tier  |
        // | ST:   NVU                     |                   |                  |  Spillover Tier  |                 |
        // +-------------------------------+-------------------+------------------+------------------+-----------------+
        // | NT:   NVU                     |                   |    Normal Tier   |                  |    Normal Tier  |
        // | ST:   VU                      |  Spillover Tier   |                  |  Spillover Tier  |                 |
        // +-------------------------------+-------------------+------------------+------------------+-----------------+
        // | NT:   VU                      |    Normal Tier    |    Normal Tier   |    Normal Tier   |    Normal Tier  |
        // | ST:   NVU                     |                   |                  |                  |                 |
        // +-------------------------------+-------------------+------------------+------------------+-----------------+

        // TODO GUY GAP do we need the case of no_good_tier?
        // no_good_tier = _.every(tiering_alloc_sorted_by_order, alloc => !_is_chunk_good_alloc(alloc) && !_is_valid_for_allocation_alloc(alloc));

        // Spillback considerations:
        // We change from a spillover tier to a non-spillover target tier
        // when the target tier has room, even if it might require allocations
        if (!this.spillover && best_mapper.spillover && this.valid_for_allocation) return true;
        if (this.spillover && !best_mapper.spillover && best_mapper.valid_for_allocation) return false;

        // Allocation effort considerations:
        // TODO rebuild effort considerations - number of allocations / replica vs erasure coding
        // - Example A: 2 allocations is less attractive than 1 allocation
        // - Example B: 2 allocations is more attractive than 1 allocation of EC decode (maybe?)
        if (!tier_mapping.allocations && best_mapping.allocations) return true;
        if (tier_mapping.allocations && !best_mapping.allocations) return false;

        // Space considerations:
        // Prefer tiers that have more room
        if (this.valid_for_allocation && !best_mapper.valid_for_allocation) return true;
        if (!this.valid_for_allocation && best_mapper.valid_for_allocation) return false;

        // Spillover considerations:
        // only chose spillover if no other option
        if (!this.spillover && best_mapper.spillover) return true;
        if (this.spillover && !best_mapper.spillover) return false;

        // Default: prefer lower order as defined in the tiering policy
        return this.order <= best_mapper.order;
    }
}


/**
 *
 *
 * TieringMapper
 *
 * 
 */
class TieringMapper {

    constructor(tiering) {
        this.tier_mappers = tiering.tiers
            .filter(t => !t.disabled)
            .sort((t, s) => t.order - s.order)
            .map(t => new TierMapper(t));
    }

    update_status(tiering_status) {
        const { tier_mappers } = this;

        for (let i = 0; i < tier_mappers.length; ++i) {
            const tier_mapper = tier_mappers[i];
            const tier_status = tiering_status[tier_mapper.tier._id];
            tier_mapper.update_status(tier_status);
        }
    }

    /**
     * Map a chunk based on the entire tiering policy
     * Works by picking the tier we want best for the chunk to be stored in,
     * @returns {Object} tier_mapping with mapping info for the chunk (allocations, deletions, ...)
     */
    map_tiering(chunk_mapper) {
        const { tier_mappers } = this;
        let best_mapper;
        let best_mapping;

        for (let i = 0; i < tier_mappers.length; ++i) {
            const tier_mapper = tier_mappers[i];
            const tier_mapping = tier_mapper.map_tier(chunk_mapper, best_mapper, best_mapping);
            if (!best_mapper || tier_mapper.is_best_tier(tier_mapping, chunk_mapper, best_mapper, best_mapping)) {
                best_mapper = tier_mapper;
                best_mapping = tier_mapping;
            }
        }

        return best_mapping;
    }
}

const tiering_mapper_cache = {
    hits: 0,
    miss: 0,
    map: new WeakMap(),
};

/**
 * 
 * map_chunk() the main mapper functionality
 * decide how to map a given chunk, either new, or existing
 * 
 * @param {Object} chunk The data chunk, with chunk.blocks populated
 * @param {Object} tiering The bucket tiering
 * @param {Object} tiering_status See node_allocator.get_tiering_status()
 * @returns {Object} mapping
 */
function map_chunk(chunk, tiering, tiering_status) {

    // const tiering_mapper = new TieringMapper(tiering);

    let tiering_mapper = tiering_mapper_cache.map.get(tiering);
    if (tiering_mapper) {
        tiering_mapper_cache.hits += 1;
    } else {
        tiering_mapper_cache.miss += 1;
        tiering_mapper = new TieringMapper(tiering);
        tiering_mapper_cache.map.set(tiering, tiering_mapper);
    }
    if ((tiering_mapper_cache.hits + tiering_mapper_cache.miss + 1) % 50 === 0) {
        dbg.log0('tiering_mapper_cache:', tiering_mapper_cache);
    }

    tiering_mapper.update_status(tiering_status);

    const chunk_mapper = new ChunkMapper(chunk);
    const mapping = tiering_mapper.map_tiering(chunk_mapper);

    if (dbg.should_log(2)) {
        if (dbg.should_log(3)) {
            dbg.log1('map_chunk: tiering_mapper', util.inspect(tiering_mapper, true, null, true));
            dbg.log1('map_chunk: chunk_mapper', util.inspect(chunk_mapper, true, null, true));
        }
        dbg.log1('map_chunk: mapping', util.inspect(mapping, true, null, true));
    }

    return mapping;
}


function is_chunk_good_for_dedup(chunk, tiering, tiering_status) {
    const mapping = map_chunk(chunk, tiering, tiering_status);
    return mapping.accessible && !mapping.allocations;
}

function assign_node_to_block(block, node, system_id) {

    const system = system_store.data.get_by_id(system_id);
    if (!system) throw new Error('Could not find system ' + system_id);

    const pool = system.pools_by_name[node.pool];
    if (!pool) throw new Error('Could not find pool ' + node.pool);

    block.node = node;
    block.pool = pool._id;
}

function get_num_blocks_per_chunk(tier) {
    const {
        chunk_coder_config: {
            replicas = 1,
            data_frags = 1,
            parity_frags = 0,
        }
    } = tier.chunk_config;
    return replicas * (data_frags + parity_frags);
}

function analyze_special_chunks(chunks, parts, objects) {
    _.forEach(chunks, chunk => {
        chunk.is_special = false;
        var tmp_parts = _.filter(parts, part => String(part.chunk) === String(chunk._id));
        var tmp_objects = _.filter(objects, obj => _.find(tmp_parts, part => String(part.obj) === String(obj._id)));
        _.forEach(tmp_objects, obj => {
            if (_.includes(config.SPECIAL_CHUNK_CONTENT_TYPES, obj.content_type)) {
                let obj_parts = _.filter(tmp_parts, part => String(part.obj) === String(obj._id));
                _.forEach(obj_parts, part => {
                    if (part.start === 0 || part.end === obj.size) {
                        chunk.is_special = true;
                    }
                });
            }
        });
    });
}

function get_part_info(part, adminfo, tiering_status) {
    return {
        start: part.start,
        end: part.end,
        seq: part.seq,
        multipart_id: part.multipart_id,
        chunk_id: part.chunk._id,
        chunk: get_chunk_info(part.chunk, adminfo, tiering_status),
        chunk_offset: part.chunk_offset, // currently undefined
    };
}

function get_chunk_info(chunk, adminfo, tiering_status) {
    if (adminfo) {
        const bucket = system_store.data.get_by_id(chunk.bucket);
        const mapping = map_chunk(chunk, bucket.tiering, tiering_status);
        if (!mapping.accessible) {
            adminfo = { health: 'unavailable' };
        } else if (mapping.allocations) {
            adminfo = { health: 'building' };
        } else {
            adminfo = { health: 'available' };
        }
    }
    const blocks_by_frag_id = _.groupBy(chunk.blocks, 'frag');
    return {
        chunk_coder_config: chunk.chunk_coder_config,
        size: chunk.size,
        frag_size: chunk.frag_size,
        compress_size: chunk.compress_size,
        digest_b64: chunk.digest && chunk.digest.toString('base64'),
        cipher_key_b64: chunk.cipher_key && chunk.cipher_key.toString('base64'),
        cipher_iv_b64: chunk.cipher_iv && chunk.cipher_iv.toString('base64'),
        cipher_auth_tag_b64: chunk.cipher_auth_tag && chunk.cipher_auth_tag.toString('base64'),
        frags: chunk.frags && _.map(chunk.frags, frag => get_frag_info(chunk, frag, blocks_by_frag_id[frag._id], adminfo)),
        adminfo,
    };
}


function get_frag_info(chunk, frag, blocks, adminfo) {
    // sorting the blocks to have most available node on front
    // TODO GUY OPTIMIZE what about load balancing - maybe random the order of good blocks
    if (blocks) blocks.sort(_block_access_sort);
    return {
        data_index: frag.data_index,
        parity_index: frag.parity_index,
        lrc_index: frag.lrc_index,
        digest_b64: frag.digest && frag.digest.toString('base64'),
        blocks: blocks && _.map(blocks, block => get_block_info(chunk, frag, block, adminfo)),
    };
}


function get_block_info(chunk, frag, block, adminfo) {
    if (adminfo) {
        const node = block.node;
        const system = system_store.data.get_by_id(block.system);
        const pool = system.pools_by_name[node.pool];
        adminfo = {
            pool_name: pool.name,
            node_name: node.os_info.hostname + '#' + node.host_seq,
            host_name: node.os_info.hostname,
            node_ip: node.ip,
            in_cloud_pool: Boolean(node.is_cloud_node),
            in_mongo_pool: Boolean(node.is_mongo_node),
            online: Boolean(node.online),
        };
    }
    return {
        block_md: get_block_md(chunk, frag, block),
        adminfo,
    };
}

function get_block_md(chunk, frag, block) {
    let delegator;
    if (block.node.node_type === 'BLOCK_STORE_S3') {
        delegator = 'DELEGATOR_S3';
    } else if (block.node.node_type === 'BLOCK_STORE_AZURE') {
        delegator = 'DELEGATOR_AZURE';
    }
    return {
        size: block.size,
        id: block._id,
        address: block.node.rpc_address,
        node: block.node._id,
        pool: block.pool,
        digest_type: chunk.chunk_coder_config.frag_digest_type,
        digest_b64: frag.digest_b64 || (frag.digest && frag.digest.toString('base64')),
        delegator,
    };
}

function _get_valid_for_allocation(tier_status, pool_id) {
    return _.get(tier_status, `pools.${pool_id}.valid_for_allocation`, false);
}

function _is_block_accessible(block) {
    return block.node.readable && !block.missing && !block.tempered;
}

function _is_block_good_node(block) {
    return block.node.writable;
}

/**
 * sorting function for sorting blocks with most recent heartbeat first
 */
function _block_access_sort(block1, block2) {
    if (!block1.node.readable) {
        return 1;
    }
    if (!block2.node.readable) {
        return -1;
    }
    return block2.node.heartbeat - block1.node.heartbeat;
}

function _block_newer_first_sort(block1, block2) {
    return block2._id.getTimestamp().getTime() - block1._id.getTimestamp().getTime();
}

function _frag_index(frag) {
    if (frag.data_index >= 0) return `D${frag.data_index}`;
    if (frag.parity_index >= 0) return `P${frag.parity_index}`;
    if (frag.lrc_index >= 0) return `L${frag.lrc_index}`;
    throw new Error('BAD FRAG ' + JSON.stringify(frag));
}

function _pool_has_redundancy(pool) {
    return pool.cloud_pool_info || pool.mongo_pool_info;
}

// EXPORTS
exports.ChunkMapper = ChunkMapper;
exports.TieringMapper = TieringMapper;
exports.map_chunk = map_chunk;
exports.is_chunk_good_for_dedup = is_chunk_good_for_dedup;
exports.assign_node_to_block = assign_node_to_block;
exports.get_num_blocks_per_chunk = get_num_blocks_per_chunk;
exports.analyze_special_chunks = analyze_special_chunks;
exports.get_part_info = get_part_info;
exports.get_chunk_info = get_chunk_info;
exports.get_frag_info = get_frag_info;
exports.get_block_info = get_block_info;
exports.get_block_md = get_block_md;