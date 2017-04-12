/* Copyright (C) 2016 NooBaa */
'use strict';

/**
 *
 * POOLS API
 *
 *
 */
module.exports = {

    id: 'pool_api',

    methods: {
        create_nodes_pool: {
            doc: 'Create Pool',
            method: 'POST',
            params: {
                $ref: '#/definitions/pool_definition'
            },
            auth: {
                system: 'admin'
            }
        },

        create_cloud_pool: {
            doc: 'Create Cloud Pool',
            method: 'POST',
            params: {
                type: 'object',
                required: ['name', 'connection', 'target_bucket'],
                properties: {
                    name: {
                        type: 'string',
                    },
                    connection: {
                        type: 'string',
                    },
                    target_bucket: {
                        type: 'string',
                    }
                }
            },
            auth: {
                system: 'admin'
            }
        },

        list_pool_nodes: {
            doc: 'List Pool Nodes',
            method: 'GET',
            params: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string',
                    },
                }
            },
            reply: {
                $ref: '#/definitions/pool_definition'
            },
            auth: {
                system: 'admin'
            }
        },

        read_pool: {
            doc: 'Read Pool Information',
            method: 'GET',
            params: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string',
                    },
                }
            },
            reply: {
                $ref: '#/definitions/pool_extended_info'
            },
            auth: {
                system: 'admin'
            }
        },

        delete_pool: {
            doc: 'Delete Pool',
            method: 'POST',
            params: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string',
                    },
                }
            },
            auth: {
                system: 'admin'
            }
        },

        assign_nodes_to_pool: {
            doc: 'Add nodes to Pool',
            method: 'POST',
            params: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string',
                    },
                    nodes: {
                        type: 'array',
                        items: {
                            $ref: 'node_api#/definitions/node_identity'
                        }
                    }
                }
            },
            auth: {
                system: 'admin'
            }
        },

        get_associated_buckets: {
            doc: 'Return list of buckets which are using this pool',
            method: 'GET',
            params: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string',
                    },
                }
            },
            reply: {
                type: 'array',
                items: {
                    type: 'string'
                }
            },
            auth: {
                system: 'admin'
            }
        },

        get_pool_history: {
            doc: 'Return usage history for the specified pools',
            method: 'GET',
            params: {
                type: 'object',
                properties: {
                    pool_list: {
                        type: 'array',
                        items: {
                            type: 'string'
                        }
                    }
                }
            },
            reply: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['timestamp', 'pool_list'],
                    properties: {
                        timestamp: {
                            format: 'idate'
                        },
                        pool_list: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['name', 'storage'],
                                properties: {
                                    name: {
                                        type: 'string'
                                    },
                                    storage: {
                                        $ref: 'common_api#/definitions/storage_info'
                                    },
                                    is_cloud_pool: {
                                        type: 'boolean'
                                    }
                                }
                            }
                        }
                    }
                }
            },
            auth: {
                system: 'admin'
            }
        }
    },

    definitions: {

        pool_definition: {
            type: 'object',
            required: ['name', 'nodes'],
            properties: {
                name: {
                    type: 'string',
                },
                nodes: {
                    type: 'array',
                    items: {
                        $ref: 'node_api#/definitions/node_identity'
                    }
                }
            }
        },


        pool_extended_info: {
            type: 'object',
            required: ['name', 'storage', 'associated_accounts'],
            properties: {
                name: {
                    type: 'string'
                },
                nodes: {
                    $ref: 'node_api#/definitions/nodes_aggregate_info'
                },
                storage: {
                    $ref: 'common_api#/definitions/storage_info'
                },
                undeletable: {
                    $ref: 'common_api#/definitions/undeletable_enum'
                },
                data_activities: {
                    $ref: 'node_api#/definitions/data_activities'
                },
                cloud_info: {
                    type: 'object',
                    properties: {
                        endpoint: {
                            type: 'string'
                        },
                        endpoint_type: {
                            type: 'string',
                            enum: ['AWS', 'AZURE', 'S3_COMPATIBLE']
                        },
                        target_bucket: {
                            type: 'string'
                        }
                    }
                },
                mode: {
                    $ref: '#/definitions/pool_mode'
                },
                associated_accounts: {
                    type: 'array',
                    items: {
                        type: 'string',
                    }
                }
            },
        },

        pools_info: {
            type: 'object',
            required: ['pools'],
            properties: {
                pools: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['name', 'nodes_count'],
                        properties: {
                            name: {
                                type: 'string',
                            },
                            nodes_count: {
                                type: 'integer',
                            },
                        }
                    }
                }
            }
        },

        pool_mode: {
            type: 'string',
            enum: [
                'HAS_NO_NODES',
                'ALL_NODES_OFFLINE',
                'NOT_ENOUGH_NODES',
                'NOT_ENOUGH_HEALTHY_NODES',
                'MANY_NODES_OFFLINE',
                'NO_CAPACITY',
                'LOW_CAPACITY',
                'HIGH_DATA_ACTIVITY',
                'IO_ERRORS',
                'BUCKET_NOT_EXIST',
                'CONTAINER_NOT_EXIST',
                'INITALIZING',
                'OPTIMAL'
            ]
        }
    }
};
