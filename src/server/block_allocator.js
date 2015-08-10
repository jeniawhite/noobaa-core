/* jshint node:true */
'use strict';

var _ = require('lodash');
var Q = require('q');
var moment = require('moment');
var db = require('./db');
var config = require('../../config.js');
var dbg = require('noobaa-util/debug_module')(__filename);


module.exports = {
    allocate_block: allocate_block,
    remove_blocks: remove_blocks,
};


/**
 *
 * allocate_blocks
 *
 * selects distinct edge node for allocating new blocks.
 *
 * @param chunk document from db
 * @param avoid_nodes array of node ids to avoid
 *
 */
function allocate_block(chunk, avoid_nodes) {
    return update_tier_alloc_nodes(chunk.system, chunk.tier)
        .then(function(alloc_nodes) {
            var block_size = (chunk.size / chunk.kfrag) | 0;
            for (var i = 0; i < alloc_nodes.length; ++i) {
                var node = get_round_robin(alloc_nodes);
                if (!_.contains(avoid_nodes, node._id.toString())) {
                    dbg.log1('allocate_block: allocate node', node.name,
                        'for chunk', chunk._id, 'avoid_nodes', avoid_nodes);
                    return new_block(chunk, node, block_size);
                }
            }
            // we looped through all nodes and didn't find a node we can allocate
            dbg.log0('allocate_block: no available node', chunk, 'avoid_nodes', avoid_nodes);
            return null;
        });
}


function remove_blocks(blocks) {
    return db.DataBlock.update({
        _id: {
            $in: _.pluck(blocks, '_id')
        }
    }, {
        deleted: new Date()
    }, {
        multi: true
    }).exec();
}


function new_block(chunk, node, size) {
    return new db.DataBlock({
        system: chunk.system,
        tier: node.tier,
        chunk: chunk,
        node: node,
        layer: 'D',
        frag: 0,
        size: size,
        building: new Date()
    });
}



var tier_alloc_nodes = {};

function update_tier_alloc_nodes(system, tier) {
    var min_heartbeat = db.Node.get_minimum_alloc_heartbeat();
    var tier_id = (tier && tier._id) || tier || null;
    var info = tier_alloc_nodes[tier_id] = tier_alloc_nodes[tier_id] || {
        last_refresh: new Date(0),
        nodes: [],
    };

    // cache the nodes for 1 minutes and then refresh
    if (info.last_refresh >= moment().subtract(1, 'minute').toDate()) {
        return Q.resolve(info.nodes);
    }

    if (info.promise) return info.promise;

    var q = {
        system: system,
        deleted: null,
        heartbeat: {
            $gt: min_heartbeat
        },
        srvmode: null,
    };
    if (tier_id) {
        q.tier = tier_id;
    }

    // refresh
    info.promise =
        db.Node.find(q)
        .sort({
            // sorting with lowest used storage nodes first
            'storage.used': 1
        })
        .limit(100)
        .exec()
        .then(function(nodes) {
            info.promise = null;
            info.nodes = nodes;
            if (nodes.length < config.min_node_number) {
                throw new Error('not enough nodes: ' + nodes.length);
            }
            info.last_refresh = new Date();
            return nodes;
        }, function(err) {
            info.promise = null;
            throw err;
        });

    return info.promise;
}


function get_round_robin(nodes) {
    var rr = nodes.rr || 0;
    nodes.rr = (rr + 1) % nodes.length;
    return nodes[rr];
}
